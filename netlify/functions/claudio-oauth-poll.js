// Claudio step 3 of sign-in: the extension polls with its `state` until the
// callback has created a session, then receives the session id exactly once.
const { pendingStore, json } = require("../lib/claudio");

exports.handler = async (event) => {
  const state = (event.queryStringParameters || {}).state || "";
  if (!/^[a-f0-9]{32,64}$/.test(state)) return json(400, { error: "invalid state" });

  const pending = pendingStore();
  const entry = await pending.get(state, { type: "json" });
  if (!entry) return json(404, { status: "unknown" });
  if (!entry.sessionId) return json(200, { status: "waiting" });

  await pending.delete(state);
  return json(200, { status: "connected", session: entry.sessionId });
};
