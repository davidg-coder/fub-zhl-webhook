// Claudio step 2 of sign-in: FUB redirects here after the agent approves.
// Exchange the code for tokens, create a session, and park the session id
// under the original `state` so the extension (polling claudio-oauth-poll)
// can pick it up.
const {
  REDIRECT_URI,
  pendingStore,
  sessionStore,
  randomId,
  tokenRequest,
} = require("../lib/claudio");

const PENDING_TTL_MS = 10 * 60 * 1000;

function page(title, message) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#f6f7fb;color:#1d2433;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#fff;border-radius:16px;padding:32px 40px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:420px;text-align:center}
h1{font-size:22px;margin:0 0 8px}p{color:#5b6475;line-height:1.5;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`,
  };
}

exports.handler = async (event) => {
  const { code, state, error, error_description: errorDescription } =
    event.queryStringParameters || {};

  if (error) {
    return page("Claudio wasn't connected", `Follow Up Boss said: ${errorDescription || error}. Close this tab and try again.`);
  }
  if (!code || !/^[a-f0-9]{32,64}$/.test(state || "")) {
    return page("Something went wrong", "This sign-in link is incomplete. Close this tab and click Connect in Claudio again.");
  }

  const pending = pendingStore();
  const entry = await pending.get(state, { type: "json" });
  if (!entry || !entry.verifier || Date.now() - entry.createdAt > PENDING_TTL_MS) {
    return page("Sign-in expired", "Close this tab and click Connect in Claudio again.");
  }

  let tokens;
  try {
    tokens = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: entry.verifier,
    });
  } catch (err) {
    console.error("Claudio code exchange failed:", err.message);
    return page("Claudio wasn't connected", "Follow Up Boss rejected the sign-in. Close this tab and try again.");
  }

  const sessionId = randomId();
  await sessionStore().setJSON(sessionId, { ...tokens, createdAt: new Date().toISOString() });
  await pending.setJSON(state, { sessionId, createdAt: entry.createdAt });

  return page("Claudio is connected ✅", "You can close this tab and go back to Follow Up Boss. Click the 🎙️ button and start talking.");
};
