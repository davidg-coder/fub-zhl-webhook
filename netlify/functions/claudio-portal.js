// Backend for Claudio inside the Power Portal (Lovable). The browser never
// calls this directly: the Portal's own edge function checks the agent's
// Portal sign-in, then calls here server to server with the shared secret
// CLAUDIO_PORTAL_SECRET plus who is asking (FUB user id + Portal role) and
// whatever plan/performance data the Portal has for them.
//
// Answers reuse claudio-ask-background. The trusted request is saved in
// portalJobStore first and the background function is only handed the jobId,
// so nobody can pose as a Portal user by calling the background function.
const crypto = require("crypto");
const { jobStore, portalJobStore, json } = require("../lib/claudio");
const { fub } = require("../lib/claudio-skills");

const SITE = process.env.URL || "https://fub-zhl-webhook.netlify.app";
const ROLES = new Set(["agent", "team_lead", "admin"]);

function secretOk(given) {
  const secret = process.env.CLAUDIO_PORTAL_SECRET;
  if (!secret || typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(secret).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!process.env.CLAUDIO_PORTAL_SECRET) return json(500, { error: "CLAUDIO_PORTAL_SECRET is not set on Netlify" });
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (!secretOk(headers["x-claudio-portal-secret"])) return json(403, { error: "forbidden" });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  const fubUserId = Number(body.fubUserId);
  if (!Number.isInteger(fubUserId) || fubUserId <= 0) return json(400, { error: "fubUserId is required" });
  // Jobs and conversations are scoped to the Portal user.
  const session = `portal:${fubUserId}`;

  switch (body.action) {
    case "ask": {
      const { jobId, conversationId, text } = body;
      if (!/^[a-f0-9]{32}$/.test(jobId || "")) return json(400, { error: "invalid jobId" });
      if (!/^[a-f0-9]{32}$/.test(conversationId || "")) return json(400, { error: "invalid conversationId" });
      if (!text || typeof text !== "string") return json(400, { error: "text is required" });
      const role = ROLES.has(body.role) ? body.role : "agent";
      // FUB's own name and role for this user, so skills check ownership the same way they do in FUB.
      let fubUser;
      try {
        fubUser = await fub(`/users/${fubUserId}`);
      } catch (err) {
        console.error("Claudio portal user lookup failed:", err.message);
        return json(404, { error: "unknown FUB user" });
      }
      const ctx = body.context || {};
      await portalJobStore().setJSON(jobId, {
        user: { id: fubUser.id, name: fubUser.name, email: fubUser.email, role: fubUser.role, portalRole: role },
        request: {
          jobId,
          session,
          conversationId,
          text: text.slice(0, 2000),
          page: {
            portal: {
              role,
              tab: typeof ctx.tab === "string" ? ctx.tab.slice(0, 60) : undefined,
              offices: Array.isArray(ctx.offices) ? ctx.offices.slice(0, 10).map(String) : undefined,
              businessPlan: ctx.businessPlan || undefined,
              performance: ctx.performance || undefined,
            },
          },
        },
        at: Date.now(),
      });
      const res = await fetch(`${SITE}/.netlify/functions/claudio-ask-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portalJob: jobId }),
      }).catch(() => null);
      if (!res || !res.ok) return json(502, { error: "start failed" });
      console.log(`Claudio portal ask user=${fubUserId} role=${role}`);
      return json(202, { status: "started" });
    }

    case "result": {
      if (!/^[a-f0-9]{32}$/.test(body.jobId || "")) return json(400, { error: "invalid jobId" });
      const jobs = jobStore();
      const job = await jobs.get(body.jobId, { type: "json" });
      if (!job) return json(200, { status: "pending" });
      if (job.session !== session) return json(404, { error: "not found" });
      await jobs.delete(body.jobId);
      return { statusCode: job.statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: job.body };
    }

    default:
      return json(400, { error: "unknown action" });
  }
};
