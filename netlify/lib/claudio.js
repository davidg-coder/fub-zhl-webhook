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
  json,
};
