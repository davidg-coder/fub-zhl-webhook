// Receives FUB's "peopleStageUpdated" webhook and pings a dedicated Slack
// channel when a "VENDE TU KASA" lead reaches one of the key seller pipeline
// stages, so leadership can watch that source's deals without digging
// through stage-webhook.js's account-wide feed.
const NOTIFY_STAGES = new Set([
  "Listing agreement",
  "Under Contract",
  "Showing Homes",
  "Submitting Offers",
]);

const SOURCE = "VENDE TU KASA";

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

  if (payload.event !== "peopleStageUpdated") {
    return { statusCode: 200, body: "ignored" };
  }

  const newStage = payload.data && payload.data.stage;
  const personIds = payload.resourceIds || [];
  if (!newStage || !NOTIFY_STAGES.has(newStage) || personIds.length === 0) {
    return { statusCode: 200, body: "ignored" };
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_VTK_URL;
  if (!webhookUrl) {
    return { statusCode: 500, body: "SLACK_WEBHOOK_VTK_URL not configured" };
  }

  for (const personId of personIds) {
    const person = await fetchPerson(personId);
    if (!person || person.source !== SOURCE) continue;

    const name = `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`;
    const agent = person.assignedTo;
    const text = `🏡 *Vende Tu Kasa:* ${name} moved to *${newStage}*` +
                 (agent ? ` (Agent: ${agent})` : "") +
                 ` — <https://power.followupboss.com/2/people/view/${personId}|Open in FUB>`;

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => {});
  }

  return { statusCode: 200, body: "ok" };
};
