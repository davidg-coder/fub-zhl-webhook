// Claudio step 1 of sign-in: the extension opens this URL in a new tab with a
// random `state`. We remember the PKCE verifier for that state and send the
// agent to FUB's consent screen.
const {
  AUTHORIZE_URL,
  CLIENT_ID,
  REDIRECT_URI,
  SCOPE,
  MCP_URL,
  pendingStore,
  pkcePair,
} = require("../lib/claudio");

exports.handler = async (event) => {
  const state = (event.queryStringParameters || {}).state || "";
  if (!/^[a-f0-9]{32,64}$/.test(state)) {
    return { statusCode: 400, body: "Missing or invalid state" };
  }

  const { verifier, challenge } = pkcePair();
  await pendingStore().setJSON(state, { verifier, createdAt: Date.now() });

  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_URL,
  }).toString();

  return { statusCode: 302, headers: { Location: url.toString() }, body: "" };
};
