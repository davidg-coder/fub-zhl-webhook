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

async function fetchPersonName(personId) {
  const res = await fetch(`https://api.followupboss.com/v1/people/${personId}`, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${process.env.FUB_API_KEY}:`).toString("base64"),
    },
  });
  if (!res.ok) return `Lead #${personId}`;
  const p = await res.json();
  return `${p.firstName || ""} ${p.lastName || ""}`.trim() || `Lead #${personId}`;
}

async function notifyZhlUpdate(personId, tag) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  const name   = await fetchPersonName(personId);
  const status = tag.replace("Zillow zhl Status: ", "");
  const emoji  = status === "Funded" ? "💰" : "🟢";
  const text   = `${emoji} *ZHL update:* ${name} is now *${status}* — ` +
                 `<https://power.followupboss.com/2/people/view/${personId}|Open in FUB>`;
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
  const matchedTags = tags.filter((t) => ZHL_TAGS.has(t));
  const personIds = payload.resourceIds || [];

  if (matchedTags.length === 0 || personIds.length === 0) {
    return { statusCode: 200, body: "no zhl tags" };
  }

  const addedAt = payload.eventCreated || new Date().toISOString();
  const store = getStore({
    name: "zhl-tag-events",
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
  const existing = (await store.get("events", { type: "json" })) || [];

  const newEntries = [];
  for (const personId of personIds) {
    for (const tag of matchedTags) {
      const alreadyLogged = existing.some(
        (e) => e.personId === personId && e.tag === tag && e.addedAt === addedAt
      );
      if (!alreadyLogged) {
        newEntries.push({ personId, tag, addedAt });
      }
    }
  }

  if (newEntries.length > 0) {
    await store.setJSON("events", [...existing, ...newEntries]);
  }

  for (const entry of newEntries) {
    if (NOTIFY_ON_TAGS.has(entry.tag)) {
      await notifyZhlUpdate(entry.personId, entry.tag);
    }
  }

  return { statusCode: 200, body: "ok" };
};
