// Receives FUB's "peopleCreated" webhook. peopleCreated carries no assignment
// info by itself (per FUB's docs — only resourceIds), so each new person is
// fetched to find out who it's assigned to. Logs one entry per (person, week)
// and fires a Slack alert the moment an agent's rolling weekly count first
// reaches WORKLOAD_THRESHOLD.
const { getStore } = require("@netlify/blobs");

const WORKLOAD_THRESHOLD = 5;

function authHeader() {
  return "Basic " + Buffer.from(`${process.env.FUB_API_KEY}:`).toString("base64");
}

async function fetchPerson(personId) {
  const res = await fetch(`https://api.followupboss.com/v1/people/${personId}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) return null;
  return res.json();
}

// Monday (Pacific time) that starts the week containing `date`, as YYYY-MM-DD.
function weekKeyFor(date) {
  const pacific = new Date(date.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const dayOffset = (pacific.getDay() + 6) % 7; // Mon=0 .. Sun=6
  pacific.setDate(pacific.getDate() - dayOffset);
  pacific.setHours(0, 0, 0, 0);
  return pacific.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    const auth = event.headers.authorization || event.headers.Authorization || "";
    if (auth !== `Bearer ${process.env.DASHBOARD_TOKEN}`) {
      return { statusCode: 401, body: "Unauthorized" };
    }
    const store = getStore({
      name: "lead-assignments",
      siteID: process.env.SITE_ID,
      token: process.env.NETLIFY_AUTH_TOKEN,
    });
    const events = (await store.get("events", { type: "json" })) || [];
    const agent = event.queryStringParameters && event.queryStringParameters.agent;
    const filtered = agent ? events.filter((e) => e.agent === agent) : events;
    return { statusCode: 200, body: JSON.stringify(filtered, null, 2) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  if (payload.event === "debugResend") {
    const auth = event.headers.authorization || event.headers.Authorization || "";
    if (auth !== `Bearer ${process.env.DASHBOARD_TOKEN}`) {
      return { statusCode: 401, body: "Unauthorized" };
    }
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    const { agent, leads } = payload;
    const links = leads
      .map((l) => `    • <https://power.followupboss.com/2/people/view/${l.personId}|${l.name}>`)
      .join("\n");
    const text = `⚠️ *Workload alert:* ${agent} has been assigned *${leads.length} new leads* this week.\n${links}`;
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return { statusCode: 200, body: "sent" };
  }

  if (payload.event !== "peopleCreated") {
    return { statusCode: 200, body: "ignored" };
  }

  const personIds = payload.resourceIds || [];
  if (personIds.length === 0) {
    return { statusCode: 200, body: "no people" };
  }

  const store = getStore({
    name: "lead-assignments",
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
  const existing    = (await store.get("events", { type: "json" })) || [];
  const existingIds = new Set(existing.map((e) => e.personId));

  const newEntries = [];
  for (const personId of personIds) {
    if (existingIds.has(personId)) continue;
    const person = await fetchPerson(personId);
    const agent  = person && person.assignedTo;
    if (!agent) continue;
    const name = `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`;
    const createdAt = person.created || new Date().toISOString();
    newEntries.push({ personId, agent, name, weekKey: weekKeyFor(new Date(createdAt)), createdAt });
  }

  if (newEntries.length === 0) {
    return { statusCode: 200, body: "no new assignments" };
  }

  const all = [...existing, ...newEntries];
  await store.setJSON("events", all);

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (webhookUrl) {
    for (const entry of newEntries) {
      const thisWeek = all.filter(
        (e) => e.agent === entry.agent && e.weekKey === entry.weekKey
      );
      if (thisWeek.length === WORKLOAD_THRESHOLD) {
        const links = thisWeek
          .map((e) => `    • <https://power.followupboss.com/2/people/view/${e.personId}|${e.name || `Lead #${e.personId}`}>`)
          .join("\n");
        const text =
          `⚠️ *Workload alert:* ${entry.agent} has been assigned *${WORKLOAD_THRESHOLD} new leads* this week.\n${links}`;
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        }).catch(() => {});
      }
    }
  }

  return { statusCode: 200, body: "ok" };
};
