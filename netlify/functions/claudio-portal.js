// Backend for Claudio inside the Power Portal (Lovable). The browser never
// calls this directly: the Portal's own edge function checks the agent's
// Portal sign-in, then calls here server to server with the shared secret
// CLAUDIO_PORTAL_SECRET plus who is asking (FUB user id + Portal role) and
// the Portal data for the profile they're looking at. Claudio here only knows
// the Portal: no FUB tools (see PORTAL_SYSTEM_PROMPT in claudio-ask).
//
// Answers reuse claudio-ask-background. The trusted request is saved in
// portalJobStore first and the background function is only handed the jobId,
// so nobody can pose as a Portal user by calling the background function.
const crypto = require("crypto");
const { jobStore, portalJobStore, json } = require("../lib/claudio");
const { fub } = require("../lib/claudio-skills");

const SITE = process.env.URL || "https://fub-zhl-webhook.netlify.app";
const ROLES = new Set(["agent", "team_lead", "admin"]);
// Who can use Claudio in the Portal: FUB user ids, comma-separated, or "all".
// CLAUDIO_PORTAL_USERS overrides the default (David 1024, Jeff 177) during the pilot.
const PORTAL_USERS = (process.env.CLAUDIO_PORTAL_USERS || "1024,177").trim().toLowerCase();

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
  const enabled = PORTAL_USERS === "all" || PORTAL_USERS.split(",").map((s) => s.trim()).includes(String(fubUserId));

  // The Portal asks first so it only shows the Claudio button to enabled users.
  if (body.action === "status") return json(200, { enabled });
  if (!enabled) return json(403, { error: "not_enabled", display: "Claudio isn't available in the Portal for you yet." });

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
              viewingAgent: typeof ctx.viewingAgent === "string" ? ctx.viewingAgent.slice(0, 100) : undefined,
              data: ctx.data || undefined,
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
