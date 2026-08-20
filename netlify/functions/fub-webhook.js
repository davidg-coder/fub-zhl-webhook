// Receives Follow Up Boss's "peopleTagsCreated" webhook and logs the exact
// moment a ZHL status tag was added to a lead, since FUB's own API never
// exposes a per-tag timestamp — this is the only place that date exists.
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const ZHL_TAGS = new Set([
  "Zillow zhl Status: Pre-approved",
  "Zillow zhl Status: Started Application",
  "Zillow zhl Status: Underwriting",
  "Zillow zhl Status: Evaluating Finances",
  "Zillow zhl Status: Funded",
]);

// Tags the recruiting dashboard's hand-raiser tracker cares about — kept
// much longer than the account-wide noise (RealScout/Fello/Zillow/etc.).
// Must be kept in sync with RECRUITING_TAGS/HOMEVALUE_TAGS in
// fub_recruiting_streamlit.py.
const LONG_RETENTION_TAGS = new Set([
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
  "homevalue_website_webdrvn",
  "homevalue_facebook_webdrvn",
]);

const DEFAULT_RETENTION_DAYS = 90;
const LONG_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// Drops events past their retention window so the Blobs store doesn't grow
// forever — every webhook call currently reads/rewrites this JSON in full.
function pruneEvents(events) {
  const now = Date.now();
  return events.filter((e) => {
    const retentionDays = LONG_RETENTION_TAGS.has(e.tag) ? LONG_RETENTION_DAYS : DEFAULT_RETENTION_DAYS;
    const addedAtMs = new Date(e.addedAt).getTime();
    return Number.isNaN(addedAtMs) || now - addedAtMs <= retentionDays * DAY_MS;
  });
}

// Tags worth an immediate Slack ping, not just a silent log entry.
const NOTIFY_ON_TAGS = new Set([
  "Zillow zhl Status: Pre-approved",
  "Zillow zhl Status: Funded",
]);

function isSignatureValid(rawBody, signatureHeader, systemKey) {
  const expected = crypto
    .createHmac("sha256", systemKey)
    .update(Buffer.from(rawBody).toString("base64"))
    .digest("hex");
  return signatureHeader === expected;
}

async function fetchPerson(personId) {
  const res = await fetch(`https://api.followupboss.com/v1/people/${personId}`, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${process.env.FUB_API_KEY}:`).toString("base64"),
    },
  });
  if (!res.ok) return null;
  return res.json();
}

async function notifyZhlUpdate(personId, tag) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  const person = await fetchPerson(personId);
  const name   = person
    ? `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`
    : `Lead #${personId}`;
  const agent  = person && person.assignedTo;
  const status = tag.replace("Zillow zhl Status: ", "");
  const emoji  = status === "Funded" ? "💰" : "🟢";
  const text   = `<!channel> ${emoji} *ZHL update:* ${name} is now *${status}*` +
                 (agent ? ` (Agent: ${agent})` : "") +
                 ` — <https://power.followupboss.com/2/people/view/${personId}|Open in FUB>`;
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const rawBody = event.body || "";
  const systemKey = process.env.FUB_SYSTEM_KEY;

  if (systemKey) {
    const signature = event.headers["fub-signature"] || event.headers["FUB-Signature"];
    if (!signature || !isSignatureValid(rawBody, signature, systemKey)) {
      return { statusCode: 401, body: "Invalid signature" };
    }
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  if (payload.event !== "peopleTagsCreated") {
    return { statusCode: 200, body: "ignored" };
  }

  const tags = (payload.data && payload.data.tags) || [];
  const personIds = payload.resourceIds || [];

  if (tags.length === 0 || personIds.length === 0) {
    return { statusCode: 200, body: "no tags" };
  }

  const addedAt = payload.eventCreated || new Date().toISOString();

  // Full account-wide log — every tag added to any person, no allowlist.
  // Powers the recruiting dashboard's "tags added in last N days" tracker,
  // which catches hand-raiser re-engagements a `created`-date filter misses.
  const allTagsStore = getStore({
    name: "all-tag-events",
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
  const existingAll = pruneEvents((await allTagsStore.get("events", { type: "json" })) || []);
  const newAllEntries = [];
  for (const personId of personIds) {
    for (const tag of tags) {
      const alreadyLogged = existingAll.some(
        (e) => e.personId === personId && e.tag === tag && e.addedAt === addedAt
      );
      if (!alreadyLogged) {
        newAllEntries.push({ personId, tag, addedAt });
      }
    }
  }
  if (newAllEntries.length > 0) {
    await allTagsStore.setJSON("events", [...existingAll, ...newAllEntries]);
  }

  // ZHL-specific log (unchanged) — only the 5 known status tags, kept
  // separate since zhl-events.js / the sales dashboard already reads this.
  const matchedTags = tags.filter((t) => ZHL_TAGS.has(t));
  if (matchedTags.length > 0) {
    const zhlStore = getStore({
      name: "zhl-tag-events",
      siteID: process.env.SITE_ID,
      token: process.env.NETLIFY_AUTH_TOKEN,
    });
    const existingZhl = (await zhlStore.get("events", { type: "json" })) || [];

    const newZhlEntries = [];
    for (const personId of personIds) {
      for (const tag of matchedTags) {
        const alreadyLogged = existingZhl.some(
          (e) => e.personId === personId && e.tag === tag && e.addedAt === addedAt
        );
        if (!alreadyLogged) {
          newZhlEntries.push({ personId, tag, addedAt });
        }
      }
    }

    if (newZhlEntries.length > 0) {
      await zhlStore.setJSON("events", [...existingZhl, ...newZhlEntries]);
    }

    for (const entry of newZhlEntries) {
      if (NOTIFY_ON_TAGS.has(entry.tag)) {
        await notifyZhlUpdate(entry.personId, entry.tag);
      }
    }
  }

  return { statusCode: 200, body: "ok" };
};
