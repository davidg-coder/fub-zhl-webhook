// Backend for the Claudio embedded app (claudio-app/index.html, shown by FUB
// in the person sidebar). Every call carries FUB's signed context, so we know
// which FUB user is asking without trusting the browser. That user's Claudio
// session is kept server side (appLinkStore), linked once through the same
// OAuth flow the extension uses. Questions reuse claudio-ask-background and
// the same job store as the extension.
const { pendingStore, sessionStore, jobStore, appLinkStore, verifyFubContext, json } = require("../lib/claudio");
const { fub } = require("../lib/claudio-skills");

const SITE = process.env.URL || "https://fub-zhl-webhook.netlify.app";

// Skills need to know who is asking. FUB's signed context already says, so the
// session gets that user (with their FUB role) instead of relying on the MCP
// get-current-user lookup, which sometimes comes back empty.
async function rememberUser(sessionId, ctxUser) {
  const sessions = sessionStore();
  const session = await sessions.get(sessionId, { type: "json" });
  if (!session) return;
  if (session.user && session.user.id === ctxUser.id && session.user.role) return;
  if (session.user && session.user.id !== ctxUser.id) {
    console.warn(`Claudio app: session user ${session.user.id} differs from FUB user ${ctxUser.id}; using FUB's`);
  }
  let role;
  try {
    role = (await fub(`/users/${ctxUser.id}`)).role;
  } catch (err) {
    console.error("Claudio app role lookup failed:", err.message);
  }
  await sessions.setJSON(sessionId, { ...session, user: { id: ctxUser.id, name: ctxUser.name, email: ctxUser.email, role } });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  if (!process.env.CLAUDIO_APP_SECRET) return json(500, { error: "CLAUDIO_APP_SECRET is not set on Netlify" });

  const ctx = verifyFubContext(body.context, body.signature);
  if (!ctx || !ctx.account || !ctx.user) return json(403, { error: "bad signature" });
  const linkKey = `${ctx.account.id}:${ctx.user.id}`;
  const links = appLinkStore();
  const session = await links.get(linkKey);

  switch (body.action) {
    case "status":
      return json(200, { connected: Boolean(session) });

    // The page opened claudio-oauth-start?state=… in a popup and polls here;
    // once the callback has made a session, it's bound to this FUB user.
    case "link": {
      const state = body.state || "";
      if (!/^[a-f0-9]{32,64}$/.test(state)) return json(400, { error: "invalid state" });
      const pending = pendingStore();
      const entry = await pending.get(state, { type: "json" });
      if (!entry) return json(404, { status: "unknown" });
      if (!entry.sessionId) return json(200, { status: "waiting" });
      await links.set(linkKey, entry.sessionId);
      await pending.delete(state);
      console.log(`Claudio app linked user=${linkKey}`);
      return json(200, { status: "connected" });
    }

    case "ask": {
      if (!session) return json(200, { needsConnect: true });
      const { jobId, conversationId, text } = body;
      if (!/^[a-f0-9]{32}$/.test(jobId || "")) return json(400, { error: "invalid jobId" });
      await rememberUser(session, ctx.user);
      const person = ctx.person || {};
      const personName = `${person.firstName || ""} ${person.lastName || ""}`.trim();
      const res = await fetch(`${SITE}/.netlify/functions/claudio-ask-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          session,
          conversationId,
          text,
          page: person.id ? { personId: person.id, personName: personName || undefined } : { path: "FUB embedded app" },
        }),
      }).catch(() => null);
      if (!res || !res.ok) return json(502, { error: "start failed" });
      return json(202, { status: "started" });
    }

    case "result": {
      if (!session) return json(200, { needsConnect: true });
      if (!/^[a-f0-9]{32}$/.test(body.jobId || "")) return json(400, { error: "invalid jobId" });
      const jobs = jobStore();
      const job = await jobs.get(body.jobId, { type: "json" });
      if (!job) return json(200, { status: "pending" });
      if (job.session !== session) return json(404, { error: "not found" });
      await jobs.delete(body.jobId);
      // The FUB sign-in behind this session is gone: forget it so the page asks to reconnect.
      if (job.statusCode === 401) {
        await links.delete(linkKey);
        return json(200, { needsConnect: true });
      }
      return { statusCode: job.statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: job.body };
    }

    case "disconnect":
      await links.delete(linkKey);
      return json(200, { ok: true });

    default:
      return json(400, { error: "unknown action" });
  }
};
