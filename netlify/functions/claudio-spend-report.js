// Runs hourly; sends once, Mondays 8 AM Pacific: estimated Claude API spend
// for last week (Mon–Sun) and month to date, from the token counts logged by
// lib/usage-log.js. It's an estimate (list prices x tokens), covering only
// Claudio and the Slack check-ins; Anthropic's Console has the real bill.
// The first run after deploy sends right away, to confirm the wiring.
const { schedule } = require("@netlify/functions");
const { readUsage, pacificDay, usageStore } = require("../lib/usage-log");
const { allUsers } = require("../lib/claudio-skills");
const { slack, slackGet } = require("../lib/checkin");

const SEND_TO = process.env.SPEND_REPORT_TO || "davidg@powerreteam.com";
const MONTHLY_LIMIT = Number(process.env.ANTHROPIC_MONTHLY_LIMIT || 1000);
const SOURCE_NAMES = { claudio: "Claudio in FUB", checkin: "Slack check-ins" };

const usd = (n) => `$${n.toFixed(n < 10 ? 2 : 0)}`;
const shiftDay = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function sumBy(rows, keyOf) {
  const out = {};
  for (const r of rows) {
    const k = keyOf(r);
    out[k] = out[k] || { cost: 0, calls: 0 };
    out[k].cost += r.cost;
    out[k].calls += 1;
  }
  return Object.entries(out).sort((a, b) => b[1].cost - a[1].cost);
}

async function buildReport(today) {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay(); // Sun=0
  const thisMonday = shiftDay(today, -((weekday + 6) % 7));
  const weekFrom = shiftDay(thisMonday, -7);
  const weekTo = shiftDay(thisMonday, -1);
  const monthFrom = `${today.slice(0, 7)}-01`;

  const [week, month] = await Promise.all([readUsage(weekFrom, weekTo), readUsage(monthFrom, today)]);
  const weekCost = week.reduce((n, r) => n + r.cost, 0);
  const monthCost = month.reduce((n, r) => n + r.cost, 0);

  const users = week.length ? await allUsers() : [];
  const nameOf = (id) => (users.find((u) => u.id === id) || {}).name || (id ? `FUB user ${id}` : "Unknown");

  const bySource = sumBy(week, (r) => r.source).map(
    ([s, v]) => `• ${SOURCE_NAMES[s] || s}: *${usd(v.cost)}* · ${v.calls} ${s === "checkin" ? "plans" : "questions"} · ${usd(v.cost / v.calls)} each`
  );
  const byModel = sumBy(week, (r) => r.model).map(([m, v]) => `• ${m}: ${usd(v.cost)}`);
  const byAgent = sumBy(week, (r) => r.fubUserId)
    .slice(0, 10)
    .map(([id, v], i) => `${i + 1}. ${nameOf(Number(id))}: ${usd(v.cost)} (${v.calls})`);

  const pct = Math.round((monthCost / MONTHLY_LIMIT) * 100);
  return [
    `💸 *Claude API spend, week of ${weekFrom} to ${weekTo}: ${usd(weekCost)}*`,
    `📅 Month to date: *${usd(monthCost)}* of ${usd(MONTHLY_LIMIT)} limit (${pct}%)${pct >= 80 ? " ⚠️" : ""}`,
    week.length ? `*By feature*\n${bySource.join("\n")}` : "No Claude calls logged last week.",
    week.length ? `*By model*\n${byModel.join("\n")}` : null,
    week.length ? `*Top agents*\n${byAgent.join("\n")}` : null,
    "_Estimate from logged tokens x list prices. Real bill: console.anthropic.com → Power Universe → Cost._",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const handler = async () => {
  const now = new Date();
  const today = pacificDay(now);
  const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const state = usageStore();
  const lastSent = await state.get("_meta/last-report");
  const due = pacific.getDay() === 1 && pacific.getHours() === 8;
  if (lastSent === today || (lastSent && !due)) return { statusCode: 200, body: "skipped" };

  const text = await buildReport(today);
  const me = (await slackGet("users.lookupByEmail", { email: SEND_TO })).user.id;
  const dm = await slack("conversations.open", { users: me });
  await slack("chat.postMessage", { channel: dm.channel.id, text, unfurl_links: false });
  await state.set("_meta/last-report", today);
  return { statusCode: 200, body: "sent" };
};

exports.handler = schedule("0 * * * *", handler);
