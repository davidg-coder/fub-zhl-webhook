// Runs hourly; at 8 AM Pacific on weekdays it starts David's meeting-task run
// (lib/my-tasks.js) in my-tasks-background, since reading the docs and
// calling Claude takes longer than a scheduled function may run.
const crypto = require("crypto");
const { schedule } = require("@netlify/functions");
const { store } = require("../lib/my-tasks");
const { pacificDay } = require("../lib/usage-log");

const SITE = process.env.URL || "https://fub-zhl-webhook.netlify.app";

const handler = async () => {
  const now = new Date();
  const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const weekday = pacific.getDay() >= 1 && pacific.getDay() <= 5;
  if (!weekday || pacific.getHours() !== 8 || (await store().get(`sent/${pacificDay(now)}`))) {
    return { statusCode: 200, body: "skipped" };
  }
  const key = crypto.createHmac("sha256", process.env.SLACK_SIGNING_SECRET || "").update("my-tasks-run").digest("hex");
  await fetch(`${SITE}/.netlify/functions/my-tasks-background`, { method: "POST", headers: { "x-my-tasks-key": key } })
    .catch((err) => console.error("My tasks handoff failed:", err.message));
  return { statusCode: 200, body: "started" };
};

exports.handler = schedule("0 * * * *", handler);
