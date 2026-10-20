// Polled by the extension after it starts claudio-ask-background. Returns
// {status: "pending"} until the answer is saved, then the answer itself with
// the status code the ask produced. Only the session that asked can read it.
const { jobStore, json } = require("../lib/claudio");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  const { jobId, session } = body;
  if (!/^[a-f0-9]{32}$/.test(jobId || "")) return json(400, { error: "invalid jobId" });

  const jobs = jobStore();
  const job = await jobs.get(jobId, { type: "json" });
  if (!job) return json(200, { status: "pending" });
  if (job.session !== session) return json(404, { error: "not found" });
  await jobs.delete(jobId);
  return { statusCode: job.statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: job.body };
};
