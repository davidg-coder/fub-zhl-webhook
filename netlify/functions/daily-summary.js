// Runs every hour; only actually sends once the Pacific-time clock hits 8 AM,
// so the message lands at 8 AM local time year-round without drifting across
// the DST switch (a fixed UTC cron would shift by an hour twice a year).
const { schedule } = require("@netlify/functions");

const OFFICES = {
  "Riverside Team": 79,
  "OC Team": 183,
  "LA Team": 178,
};

const FUB_BASE = "https://api.followupboss.com/v1";

function authHeader() {
  return "Basic " + Buffer.from(`${process.env.FUB_API_KEY}:`).toString("base64");
}

async function fubGet(endpoint, params) {
  const url = new URL(`${FUB_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`FUB ${endpoint} ${res.status}`);
  return res.json();
}

async function getTotal(endpoint, teamId, extra = {}) {
  const data = await fubGet(endpoint, { teamId, limit: 1, ...extra });
  return (data._metadata && data._metadata.total) || 0;
}

function iso(d) {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

async function buildSummary(officeName, teamId) {
  const now          = new Date();
  const since        = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const dayAgo       = new Date(now.getTime() - 24 * 3600 * 1000);
  const noContactCut = new Date(now.getTime() - 24 * 3600 * 1000);

  const [totalContacts, underContract, submitting, showing, apptSet, newLeads, noContact, overdueTotal] =
    await Promise.all([
      getTotal("people", teamId),
      getTotal("people", teamId, { stageId: 27 }),
      getTotal("people", teamId, { stageId: 26 }),
      getTotal("people", teamId, { stageId: 25 }),
      getTotal("people", teamId, { stageId: 23 }),
      getTotal("people", teamId, { createdAfter: iso(since) }),
      getTotal("people", teamId, { createdAfter: iso(noContactCut), createdBefore: iso(dayAgo) }),
      getTotal("tasks", teamId, { isCompleted: "false", dueDateBefore: iso(now) }),
    ]);

  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "America/Los_Angeles",
  });

  return `*🏠 Power Real Estate Group — Daily FUB Summary*
*${dateStr}  |  Team: ${officeName}*

📊 *Pipeline Snapshot*
• 🟢 Under Contract: ${underContract}
• 🔵 Submitting Offers: ${submitting}
• 🟡 Showing Homes: ${showing}
• 🟠 Appointment Set: ${apptSet}

📥 *New Leads (last 7d):* ${newLeads.toLocaleString()}
⚠️ *Without Contact (24h+):* ${noContact.toLocaleString()}
🔴 *Overdue Tasks:* ${overdueTotal.toLocaleString()}
📋 *Total Contacts in FUB:* ${totalContacts.toLocaleString()}`;
}

const handler = async () => {
  const pacificHour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", hour: "numeric", hour12: false,
    }).format(new Date()),
    10
  );

  if (pacificHour !== 8) {
    return { statusCode: 200, body: `skipped — Pacific hour is ${pacificHour}, waiting for 8` };
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl || !process.env.FUB_API_KEY) {
    return { statusCode: 500, body: "SLACK_WEBHOOK_URL or FUB_API_KEY not configured" };
  }

  for (const [officeName, teamId] of Object.entries(OFFICES)) {
    const text = await buildSummary(officeName, teamId);
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  return { statusCode: 200, body: "sent" };
};

exports.handler = schedule("0 * * * *", handler);
