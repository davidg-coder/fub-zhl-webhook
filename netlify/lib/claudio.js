// Shared plumbing for the Claudio voice assistant (Chrome extension inside
// Follow Up Boss). Each agent signs in to FUB's official MCP server with their
// own account (OAuth + PKCE), so Claudio only ever sees what that agent can
// see in FUB. Their tokens live in Netlify Blobs, keyed by an opaque session
// id that the extension keeps in chrome.storage.
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const MCP_URL = "https://mcp.zillow.com/api/fub-public";
const AUTHORIZE_URL = `${MCP_URL}/authorize`;
const TOKEN_URL = `${MCP_URL}/token`;
// Public client registered via dynamic client registration (no secret; PKCE).
const CLIENT_ID = "189cd617-6307-465c-ad3e-b093673f6958";
const REDIRECT_URI =
  "https://fub-zhl-webhook.netlify.app/.netlify/functions/claudio-oauth-callback";
const SCOPE = "openid profile email";

function store(name) {
  return getStore({
    name,
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
    consistency: "strong",
  });
}

const pendingStore = () => store("claudio-oauth-pending");
const sessionStore = () => store("claudio-sessions");
const convoStore = () => store("claudio-conversations");

function randomId(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function pkcePair() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: CLIENT_ID, resource: MCP_URL, ...params }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FUB token endpoint ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // Refresh a minute early so a token never expires mid-request.
    expiresAt: Date.now() + ((data.expires_in || 3600) - 60) * 1000,
  };
}

// Returns a valid FUB MCP access token for the session, refreshing it when
// it's about to expire. Throws "SESSION_INVALID" when the agent must re-connect.
async function accessTokenFor(sessionId) {
  if (!/^[a-f0-9]{64}$/.test(sessionId || "")) throw new Error("SESSION_INVALID");
  const sessions = sessionStore();
  const session = await sessions.get(sessionId, { type: "json" });
  if (!session) throw new Error("SESSION_INVALID");
  if (Date.now() < session.expiresAt) return session.accessToken;
  if (!session.refreshToken) throw new Error("SESSION_INVALID");

  let refreshed;
  try {
    refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: session.refreshToken });
  } catch (err) {
    console.error("Claudio token refresh failed:", err.message);
    throw new Error("SESSION_INVALID");
  }
  await sessions.setJSON(sessionId, {
    ...session,
    ...refreshed,
    refreshToken: refreshed.refreshToken || session.refreshToken,
    refreshedAt: new Date().toISOString(),
  });
  return refreshed.accessToken;
}

// Minimal MCP JSON-RPC call against FUB's server. Responses may come back as
// plain JSON or as a one-shot SSE stream, so both are handled.
async function mcpRpc(token, mcpSessionId, method, params, id) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (mcpSessionId) headers["Mcp-Session-Id"] = mcpSessionId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) throw new Error(`FUB MCP ${method} ${res.status}`);
  const text = await res.text();
  let message = null;
  if (text.trim().startsWith("{")) {
    message = JSON.parse(text);
  } else {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const parsed = JSON.parse(line.slice(5));
      if (parsed.id === id) message = parsed;
    }
  }
  return { message, mcpSessionId: res.headers.get("mcp-session-id") || mcpSessionId };
}

// Fields FUB returns that only cost tokens and never help a spoken answer.
const NOISE_KEYS = new Set([
  "picture", "mlsMemberships", "leadEmailAddress", "fuid", "acceptedShowingtimeConsent",
  "acceptedShowingtimeConsentV2", "lastSeenIos", "lastSeenAndroid", "canExport",
  "canCreateApiKeys", "beta", "nextLink", "_links",
]);

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (NOISE_KEYS.has(k) || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      out[k] = compact(v);
    }
    return out;
  }
  return value;
}

const MAX_RESULT_CHARS = 40000;

// A small MCP client for FUB's server. We call the tools ourselves (instead
// of the API's MCP connector) because FUB puts most tool data in
// structuredContent, which the connector doesn't pass on to Claude.
async function openMcp(token) {
  let nextId = 1;
  const init = await mcpRpc(token, null, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claudio", version: "0.2.0" },
  }, nextId++);
  const sid = init.mcpSessionId;
  await mcpRpc(token, sid, "notifications/initialized", {});

  return {
    async listTools() {
      const tools = [];
      let cursor;
      do {
        const res = await mcpRpc(token, sid, "tools/list", cursor ? { cursor } : {}, nextId++);
        const r = res.message?.result || {};
        tools.push(...(r.tools || []));
        cursor = r.nextCursor;
      } while (cursor);
      return tools;
    },
    // Returns { text, isError, data }: text is what Claude sees.
    async callTool(name, args) {
      const res = await mcpRpc(token, sid, "tools/call", { name, arguments: args || {} }, nextId++);
      if (res.message?.error) return { text: `Error: ${res.message.error.message}`, isError: true, data: null };
      const r = res.message?.result || {};
      const summary = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      let data = r.structuredContent || null;
      if (!data) {
        try {
          data = JSON.parse(summary);
        } catch {}
      }
      let text = data ? JSON.stringify(compact(data)) : summary;
      if (text.length > MAX_RESULT_CHARS) {
        text = `${text.slice(0, MAX_RESULT_CHARS)} …[truncated; narrow the request or page with the cursor]`;
      }
      return { text: text || "(empty result)", isError: Boolean(r.isError), data };
    },
  };
}

// Who the agent is in FUB ({id, name, email, role}). Looked up once through
// the get-current-user tool and cached on the session, so Claude gets the
// agent's FUB name up front (query_people's assignedTo filter matches names,
// not emails). Returns null if the lookup fails; Claude can still ask.
async function currentUserFor(sessionId, mcp, toolName) {
  const sessions = sessionStore();
  const session = await sessions.get(sessionId, { type: "json" });
  if (session && session.user) return session.user;
  try {
    const { data } = await mcp.callTool(toolName, {});
    const u = data && (data.session?.user || data.user);
    if (!u || !u.name) throw new Error("no user in get-current-user result");
    const user = { id: u.id, name: u.name, email: u.email, role: u.role };
    if (session) await sessions.setJSON(sessionId, { ...session, user });
    return user;
  } catch (err) {
    console.error("Claudio current-user lookup failed:", err.message);
    return null;
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

module.exports = {
  MCP_URL,
  AUTHORIZE_URL,
  CLIENT_ID,
  REDIRECT_URI,
  SCOPE,
  pendingStore,
  sessionStore,
  convoStore,
  randomId,
  pkcePair,
  tokenRequest,
  accessTokenFor,
  openMcp,
  currentUserFor,
  json,
};
