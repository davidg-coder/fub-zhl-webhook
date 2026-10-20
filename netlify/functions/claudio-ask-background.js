// Background version of claudio-ask: Netlify answers 202 right away and lets
// this run up to 15 minutes, so multi-step questions (team stats, several
// FUB lookups) aren't cut off by the sync function limit. The answer is saved
// under the extension's jobId and fetched by polling claudio-result.
const { jobStore } = require("../lib/claudio");
const { runAsk } = require("./claudio-ask");

exports.handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return;
  }
  const { jobId, session } = body;
  if (!/^[a-f0-9]{32}$/.test(jobId || "") || typeof session !== "string") return;

  let result;
  try {
    result = await runAsk(body);
  } catch (err) {
    console.error("Claudio background ask crashed:", err);
    result = {
      statusCode: 500,
      body: JSON.stringify({
        error: "crash",
        speech: "Something went wrong on my side. Please try again.",
        display: `Something went wrong on my side: ${String(err && err.message).slice(0, 400)}`,
      }),
    };
  }
  await jobStore().setJSON(jobId, { session, statusCode: result.statusCode, body: result.body, at: Date.now() });
};
