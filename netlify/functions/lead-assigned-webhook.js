// Receives FUB's "peopleCreated" webhook. peopleCreated carries no assignment
// info by itself (per FUB's docs — only resourceIds), so each new person is
// fetched to find out who it's assigned to. Logs one entry per (person, week)
// and fires a Slack alert the moment an agent's rolling weekly count first
// reaches WORKLOAD_THRESHOLD.
//
// Also carries an unrelated second concern: routing every new lead to a
// pipeline-manager Slack channel (Buyers/Sellers/Recruiting) plus a firehose
// channel that gets all of them, so managers only see leads for their own
// area. Lives here instead of its own function because FUB caps active
// webhooks per event at 2, and peopleCreated's other slot is unused but
// registering a new webhook requires an account-owner API key (the shared
// key 403s on GET /webhooks) — piggybacking on this function's existing
// registration avoids that dependency entirely.
const { getStore } = require("@netlify/blobs");

const WORKLOAD_THRESHOLD = 5;

// Sellers and Recruiting are classified mainly by tag — tag names are
// purpose-built for this, while `source` is reused loosely across pipelines
// (e.g. "Website" or "Jose Samano SOI" isn't reliably recruiting-only) and is
// only trusted as a fallback for Recruiting leads that haven't been tagged.
// Confirmed with David 2026-09-22: homevalue_facebook_webdrvn and
// homevalue_website_webdrvn are Sellers-only even though they also showed up
// in a Recruiting tag picker (that picker just listed all tags account-wide).
const SELLER_TAGS = new Set([
  "Zillow seller",
  "homevalue_facebook_webdrvn",
  "homevalue_website_webdrvn",
]);

const RECRUITING_TAGS = new Set([
  "Courted.io",
  "Courted.io - Recruiting Auto",
  "Courted.io - Handraiser",
  "meta ads (recruiting)",
  "Join Power",
  "Join Power | Meta Ads | Reclutamiento 2/24/26",
  "Form: Join Power",
  "Reclutamiento 2/24/26",
  "leadngage_recruitment_sh",
  "recruiting_facebook_webdrvn",
  "resubido_agents_recruitment",
  "this person requested to join Power",
]);

const RECRUITING_SOURCES = new Set([
  "Humaniz.io",
  "Recruiting",
  "Courted.io",
  "Power Meta Ads (Recruiting)",
  "MarketView Broker",
  "Power Real Estate Group",
  "Recruiting www.joinpowerreteam.com",
  "Humaniz",
  "Jose Samano SOI",
  "Website",
  "DRE New Licensee",
  "Join Power Re Team Website",
  "joinpowerreteam.com",
]);

// "Personal client"/"Personal" are manually-created/imported leads, not real
// pipeline traffic — they drowned out genuine Buyers leads (229 of 351 leads
// in a 2-day sample). Excluded from all 3 pipeline channels per David
// 2026-09-23, but still posted to the firehose channel since that's his own
// full feed.
const EXCLUDED_SOURCES = new Set(["Personal client", "Personal"]);

const PIPELINE_LABELS = { sellers: "Sellers", recruiting: "Recruiting", buyers: "Buyers" };

const PIPELINE_WEBHOOKS = {
  sellers: process.env.SLACK_WEBHOOK_PIPELINE_SELLERS_URL,
  recruiting: process.env.SLACK_WEBHOOK_PIPELINE_RECRUITING_URL,
  buyers: process.env.SLACK_WEBHOOK_PIPELINE_BUYERS_URL,
};
const FIREHOSE_WEBHOOK_URL = process.env.SLACK_WEBHOOK_PIPELINE_FIREHOSE_URL;

// Buyers is the catch-all: a lead only lands there if it matches neither
// Sellers' nor Recruiting's rules. A lead can match both Sellers and
// Recruiting at once (e.g. a recruit who's also tagged as a seller lead) and
// gets posted to both — confirmed with David 2026-09-22.
function classifyPipelines(person) {
  const tags = person.tags || [];
  const source = person.source || "";
  const pipelines = [];
  if (tags.some((t) => SELLER_TAGS.has(t))) pipelines.push("sellers");
  if (tags.some((t) => RECRUITING_TAGS.has(t)) || RECRUITING_SOURCES.has(source)) {
    pipelines.push("recruiting");
  }
  if (pipelines.length === 0) pipelines.push("buyers");
  return pipelines;
}

async function postSlack(url, text) {
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

async function routeNewLead(person) {
  const pipelines = EXCLUDED_SOURCES.has(person.source) ? [] : classifyPipelines(person);
  const name = `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${person.id}`;
  const agent = person.assignedTo;
  const agentSuffix = agent ? ` (Agent: ${agent})` : "";
  const link = `<https://power.followupboss.com/2/people/view/${person.id}|Open in FUB>`;

  for (const pipeline of pipelines) {
    const text = `<!channel> 🆕 *Claudio AI — ${PIPELINE_LABELS[pipeline]}:* New lead — ${name}${agentSuffix} — ${link}`;
    await postSlack(PIPELINE_WEBHOOKS[pipeline], text);
  }

  const routedTo = pipelines.length
    ? pipelines.map((p) => PIPELINE_LABELS[p]).join(", ")
    : "none (excluded source)";
  const firehoseText =
    `<!channel> 🆕 *Claudio AI — Firehose:* New lead — ${name}${agentSuffix}` +
    ` → routed to *${routedTo}* — ${link}`;
  await postSlack(FIREHOSE_WEBHOOK_URL, firehoseText);
}

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
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
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
  const routingTasks = [];
  for (const personId of personIds) {
    if (existingIds.has(personId)) continue;
    const person = await fetchPerson(personId);
    if (!person) continue;
    routingTasks.push(routeNewLead(person));

    const agent = person.assignedTo;
    if (!agent) continue;
    const name = `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`;
    const createdAt = person.created || new Date().toISOString();
    newEntries.push({ personId, agent, name, weekKey: weekKeyFor(new Date(createdAt)), createdAt });
  }

  await Promise.all(routingTasks);

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
          `<!channel> ⚠️ *Workload alert:* ${entry.agent} has been assigned *${WORKLOAD_THRESHOLD} new leads* this week.\n${links}`;
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
