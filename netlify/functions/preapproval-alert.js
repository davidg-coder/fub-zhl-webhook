// Runs every 15 min. Zillow Home Loans logs a lender's pre-approval as a
// generic FUB "event" (type: "Pre-Approval", source: "Zillow") — it never
// shows up in /notes, /textMessages, or /emails, so nothing else in this repo
// would ever see it. This polls the account-wide /events feed for that type,
// walks pagination newest-first and stops as soon as it reaches an event
// older than `since` (the feed has 200+ historical events; no need to read
// all of them every run). A Netlify Blobs store of already-alerted event IDs
// keeps it from repeating, same pattern as overdue-escalation.js.
const { schedule } = require("@netlify/functions");
const { getStore } = require("@netlify/blobs");

const FUB_BASE = "https://api.followupboss.com/v1";
const MAX_ID_AGE_DAYS = 180;

function authHeader() {
  return "Basic " + Buffer.from(`${process.env.FUB_API_KEY}:`).toString("base64");
}

function iso(d) {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

async function fetchPerson(personId) {
  const res = await fetch(`${FUB_BASE}/people/${personId}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) return null;
  return res.json();
}

// Fetches Pre-Approval events newer than `sinceMs`, stopping at the first
// page boundary crossed into older events (feed is sorted newest-first).
async function fetchNewPreApprovals(sinceMs) {
  const found = [];
  let next = null;
  let page = 0;
  do {
    const url = new URL(`${FUB_BASE}/events`);
    url.searchParams.set("type", "Pre-Approval");
    url.searchParams.set("limit", "50");
    if (next) url.searchParams.set("next", next);
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) throw new Error(`FUB events ${res.status}`);
    const data = await res.json();
    const events = data.events || [];
    let hitOld = false;
    for (const e of events) {
      if (new Date(e.occurred).getTime() <= sinceMs) {
        hitOld = true;
        break;
      }
      found.push(e);
    }
    if (hitOld) break;
    next = data._metadata && data._metadata.next;
    page++;
  } while (next && page < 10);
  return found;
}

const handler = async () => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl || !process.env.FUB_API_KEY) {
    return { statusCode: 500, body: "SLACK_WEBHOOK_URL or FUB_API_KEY not configured" };
  }

  const store = getStore({
    name: "preapproval-alerts",
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });

  let since = await store.get("since", { type: "text" });
  if (!since) {
    since = iso(new Date());
    await store.setJSON("ids", []);
    await store.set("since", since);
    return { statusCode: 200, body: `initialized — only watching pre-approvals after ${since}` };
  }

  const sinceMs = new Date(since).getTime();
  const alerted = new Map((await store.get("ids", { type: "json" })) || []);
  const events = await fetchNewPreApprovals(sinceMs);
  const newOnes = events.filter((e) => !alerted.has(e.id));

  for (const e of newOnes) {
    const person = await fetchPerson(e.personId);
    const name = person
      ? `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${e.personId}`
      : `Lead #${e.personId}`;
    const agent = person && person.assignedTo;
    const amount = e.additional && e.additional.preApprovalAmount;
    const amountStr = typeof amount === "number" ? `$${amount.toLocaleString()}` : "an unspecified amount";
    const text =
      `🏠 *Pre-approval:* *${name}* was just pre-approved for ${amountStr}` +
      (agent ? ` (Agent: ${agent})` : "") +
      ` — <https://power.followupboss.com/2/people/view/${e.personId}|Open in FUB>`;
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => {});
    alerted.set(e.id, e.occurred);
  }

  if (newOnes.length > 0) {
    const cutoff = Date.now() - MAX_ID_AGE_DAYS * 24 * 3600 * 1000;
    for (const [id, occurred] of alerted) {
      if (new Date(occurred).getTime() < cutoff) alerted.delete(id);
    }
    await store.setJSON("ids", [...alerted]);
  }

  return {
    statusCode: 200,
    body: `checked ${events.length} pre-approval events since last watermark, alerted ${newOnes.length}`,
  };
};

exports.handler = schedule("*/15 * * * *", handler);
