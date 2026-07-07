// Runs hourly; only sends once, at 8 AM Pacific on Fridays. Reads the
// stage-changes log written by stage-webhook.js and ranks agents by how many
// leads they moved to "Appointment Set" or "Under Contract" during the
// current Monday–Sunday (Pacific) week — a proxy for "who won this week"
// that FUB's own API has no direct query for.
const { schedule } = require("@netlify/functions");
const { getStore } = require("@netlify/blobs");

const COUNTED_STAGES = new Set(["Appointment Set", "Under Contract"]);

// Monday (Pacific time) that starts the week containing `date`, as YYYY-MM-DD.
function weekKeyFor(date) {
  const pacific = new Date(date.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const dayOffset = (pacific.getDay() + 6) % 7; // Mon=0 .. Sun=6
  pacific.setDate(pacific.getDate() - dayOffset);
  pacific.setHours(0, 0, 0, 0);
  return pacific.toISOString().slice(0, 10);
}

function buildLeaderboardText(events, currentWeekKey) {
  const counts = {};
  for (const e of events) {
    if (!e.agent || !COUNTED_STAGES.has(e.stage)) continue;
    if (weekKeyFor(new Date(e.at)) !== currentWeekKey) continue;
    counts[e.agent] = (counts[e.agent] || 0) + 1;
  }

  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (ranked.length === 0) {
    return "*🏆 Weekly Leaderboard* — no Appointment Set / Under Contract moves logged yet this week.";
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = ranked.map(
    ([agent, count], i) => `${medals[i] || "▪️"} ${agent} — ${count}`
  );
  return `*🏆 Weekly Leaderboard* — Appointment Set + Under Contract moves\n${lines.join("\n")}`;
}

const handler = async (event) => {
  const now = new Date();
  const pacific = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);

  const weekday = pacific.find((p) => p.type === "weekday").value;
  const hour = parseInt(pacific.find((p) => p.type === "hour").value, 10);

  // ?test=1 lets us manually verify the ranking output without waiting for
  // Friday 8 AM — remove once this has been confirmed working end-to-end.
  const isTest = event && event.queryStringParameters && event.queryStringParameters.test === "1";

  if (!isTest && (weekday !== "Fri" || hour !== 8)) {
    return { statusCode: 200, body: `skipped — Pacific is ${weekday} ${hour}:00, waiting for Fri 8:00` };
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return { statusCode: 500, body: "SLACK_WEBHOOK_URL not configured" };
  }

  const store = getStore({
    name: "stage-changes",
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
  const events = (await store.get("events", { type: "json" })) || [];

  const text = buildLeaderboardText(events, weekKeyFor(now));
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  return { statusCode: 200, body: "sent" };
};

exports.handler = schedule("0 * * * *", handler);
