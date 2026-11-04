// David's weekday-morning meeting-task run, started by my-tasks-reminder.
// The key is an HMAC of the Slack signing secret, so only our own functions
// can start it.
const crypto = require("crypto");
const { runDaily } = require("../lib/my-tasks");

exports.handler = async (event) => {
  const expected = crypto.createHmac("sha256", process.env.SLACK_SIGNING_SECRET || "").update("my-tasks-run").digest("hex");
  const given = String(event.headers["x-my-tasks-key"] || "");
  if (!process.env.SLACK_SIGNING_SECRET || given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    console.warn("My tasks: bad key");
    return;
  }
  try {
    await runDaily();
  } catch (err) {
    console.error("My tasks run failed:", err);
  }
};
