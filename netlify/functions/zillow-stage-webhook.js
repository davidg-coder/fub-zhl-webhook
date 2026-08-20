// Receives FUB's "peopleStageUpdated" webhook (registered separately from
// stage-webhook.js and vtk-stage-webhook.js) and pings the Slack channel for
// a Zillow lead's office when it reaches one of the key buyer pipeline
// stages, so each office can watch its own Zillow deals without digging
// through the account-wide feed. Office is read from the "Flex Profile"
// custom field (customFlexProfile) — only returned by the FUB API when the
// request explicitly asks for fields=allFields.
const NOTIFY_STAGES = new Set([
  "Submitting Offers",
  "Showing Homes",
  "Listing Agreement",
  "Under Contract",
]);

const OFFICE_WEBHOOKS = {
  "Los Angeles": process.env.SLACK_WEBHOOK_ZILLOW_LA_URL,
  "Orange County": process.env.SLACK_WEBHOOK_ZILLOW_OC_URL,
  "Riverside": process.env.SLACK_WEBHOOK_ZILLOW_RV_URL,
};

function authHeader() {
  return "Basic " + Buffer.from(`${process.env.FUB_API_KEY}:`).toString("base64");
}

async function fetchPerson(personId) {
  const res = await fetch(`https://api.followupboss.com/v1/people/${personId}?fields=allFields`, {
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

  for (const personId of personIds) {
    const person = await fetchPerson(personId);
    if (!person) continue;

    const source = (person.source || "").toLowerCase();
    if (!source.includes("zillow")) continue;

    const office = String(person.customFlexProfile || "").trim();
    const webhookUrl = OFFICE_WEBHOOKS[office];
    if (!webhookUrl) continue; // no Flex Profile match — nowhere to send it

    const name = `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`;
    const agent = person.assignedTo;
    const text = `🏠 *Claudio AI — Zillow:* ${name} moved to *${newStage}*` +
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
