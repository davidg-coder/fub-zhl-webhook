// Receives FUB's "peopleStageUpdated" webhook. The payload only carries the
// new stage name (no previous value — confirmed via FUB docs), so the last
// known stage per person is kept in Blobs to detect when a lead moves
// backward (a strong "this deal may be falling apart" signal). Every change
// is also appended to a log that weekly-leaderboard.js reads to rank agents.
//
// Also carries two unrelated concerns that would otherwise need their own
// webhook: office-routed Zillow milestone alerts, and a Riverside-only
// Appointment Set alert (any source). FUB caps active webhooks per event at
// 2 (already used up by this function + vtk-stage-webhook.js), so a 3rd
// peopleStageUpdated registration isn't possible — both live here instead.
const { getStore } = require("@netlify/blobs");

// Most-advanced first — mirrors PIPELINE_STAGES in fub_streamlit.py.
const STAGE_RANK = {
  "Under Contract":      0,
  "Submitting Offers":   1,
  "Showing Homes":       2,
  "Met with customer":   3,
  "Appointment Set":     4,
  "Spoke with Customer": 5,
  "Attempted Contact":   6,
  "Lead":                7,
};

// Zillow-lead milestone stages, routed to the lead's office via the "Flex
// Profile" custom field (customFlexProfile) — only returned by the FUB API
// when the request explicitly asks for fields=allFields.
const ZILLOW_NOTIFY_STAGES = new Set([
  "Submitting Offers",
  "Showing Homes",
  "Listing Agreement",
  "Under Contract",
]);

const ZILLOW_OFFICE_WEBHOOKS = {
  "Los Angeles": process.env.SLACK_WEBHOOK_ZILLOW_LA_URL,
  "Orange County": process.env.SLACK_WEBHOOK_ZILLOW_OC_URL,
  "Riverside": process.env.SLACK_WEBHOOK_ZILLOW_RV_URL,
};

// Riverside-only, any source — reuses the same Riverside channel as the
// Zillow office milestone alerts above (SLACK_WEBHOOK_ZILLOW_RV_URL).
const RIVERSIDE_APPOINTMENT_STAGE = "Appointment Set";

// Zillow Lead Audit System (attempted-contact pond rule): FUB exposes no
// "time in current stage" field anywhere in the API, so this webhook is the
// only place that can stamp it. n8n polls this custom field every 2h and
// reassigns to an ISA pond once a Zillow lead has sat here >24h.
const ATTEMPTED_CONTACT_STAGE = "Attempted Contact";
const ATTEMPTED_CONTACT_FIELD = "customAttemptedContactEnteredAt";

// Appointment Set daily-digest support (Zillow Lead Audit System component #2):
// stamped the same way, so the digest routine can compute "days in stage".
const APPOINTMENT_SET_STAGE = "Appointment Set";
const APPOINTMENT_SET_FIELD = "customAppointmentSetEnteredAt";

function authHeader() {
  return "Basic " + Buffer.from(`${process.env.FUB_API_KEY}:`).toString("base64");
}

async function setStageFieldTimestamp(personId, field, value) {
  await fetch(`https://api.followupboss.com/v1/people/${personId}`, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: value }),
  }).catch(() => {});
}

async function fetchPerson(personId) {
  const res = await fetch(`https://api.followupboss.com/v1/people/${personId}?fields=allFields`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) return null;
  return res.json();
}

async function notifyZillowMilestone(person, personId, newStage) {
  const source = (person.source || "").toLowerCase();
  if (!source.includes("zillow")) return;

  const office = String(person.customFlexProfile || "").trim();
  const webhookUrl = ZILLOW_OFFICE_WEBHOOKS[office];
  if (!webhookUrl) return; // no Flex Profile match — nowhere to send it

  const name = `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`;
  const agent = person.assignedTo;
  const text = `<!channel> 🏠 *Claudio AI — Zillow:* ${name} moved to *${newStage}*` +
               (agent ? ` (Agent: ${agent})` : "") +
               ` — <https://power.followupboss.com/2/people/view/${personId}|Open in FUB>`;

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

async function notifyRiversideAppointmentSet(person, personId) {
  const office = String(person.customFlexProfile || "").trim();
  if (office !== "Riverside") return;

  const webhookUrl = process.env.SLACK_WEBHOOK_ZILLOW_RV_URL;
  if (!webhookUrl) return;

  const name = `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`;
  const agent = person.assignedTo;
  const text = `<!channel> 📅 *Claudio AI — Riverside:* ${name} moved to *Appointment Set*` +
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
  if (!newStage || personIds.length === 0) {
    return { statusCode: 200, body: "no stage" };
  }

  const at = payload.eventCreated || new Date().toISOString();
  const newRank = STAGE_RANK.hasOwnProperty(newStage) ? STAGE_RANK[newStage] : null;

  const stageStore = getStore({
    name: "person-stage",
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
  const changesStore = getStore({
    name: "stage-changes",
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });

  const current = (await stageStore.get("current", { type: "json" })) || {};
  const changes = (await changesStore.get("events", { type: "json" })) || [];

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const metReminderWebhook = process.env.SLACK_WEBHOOK_MET_REMINDER_URL;
  const newChanges = [];

  for (const personId of personIds) {
    const previous = current[personId];
    const isRegression =
      previous && previous.rank !== null && newRank !== null && newRank > previous.rank;
    const isMet = newStage === "Recruiting - Met";
    const isZillowMilestone = ZILLOW_NOTIFY_STAGES.has(newStage);
    const isRiversideAppointment = newStage === RIVERSIDE_APPOINTMENT_STAGE;

    const person = newRank !== null || isRegression || isMet || isZillowMilestone
      ? await fetchPerson(personId)
      : null;
    const agent = person && person.assignedTo;
    const name = person
      ? `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`
      : `Lead #${personId}`;

    if (isZillowMilestone && person) {
      await notifyZillowMilestone(person, personId, newStage);
    }

    if (isRiversideAppointment && person) {
      await notifyRiversideAppointmentSet(person, personId);
    }

    // Attempted-contact pond rule: stamp entry (Zillow leads only), clear on exit.
    let attemptedContactTracked = false;
    const isEnteringAttemptedContact = newStage === ATTEMPTED_CONTACT_STAGE;
    const isLeavingAttemptedContact =
      previous && previous.stage === ATTEMPTED_CONTACT_STAGE && newStage !== ATTEMPTED_CONTACT_STAGE;

    if (isEnteringAttemptedContact && person) {
      const source = (person.source || "").toLowerCase();
      if (source.includes("zillow") && !person[ATTEMPTED_CONTACT_FIELD]) {
        await setStageFieldTimestamp(personId, ATTEMPTED_CONTACT_FIELD, at);
        attemptedContactTracked = true;
      }
    } else if (isLeavingAttemptedContact && previous.attemptedContactTracked) {
      await setStageFieldTimestamp(personId, ATTEMPTED_CONTACT_FIELD, "");
    }

    // Appointment Set daily-digest support: stamp entry (Zillow leads only), clear
    // on exit — same pattern as Attempted Contact above.
    let appointmentSetTracked = false;
    const isEnteringAppointmentSet = newStage === APPOINTMENT_SET_STAGE;
    const isLeavingAppointmentSet =
      previous && previous.stage === APPOINTMENT_SET_STAGE && newStage !== APPOINTMENT_SET_STAGE;

    if (isEnteringAppointmentSet && person) {
      const source = (person.source || "").toLowerCase();
      if (source.includes("zillow") && !person[APPOINTMENT_SET_FIELD]) {
        await setStageFieldTimestamp(personId, APPOINTMENT_SET_FIELD, at);
        appointmentSetTracked = true;
      }
    } else if (isLeavingAppointmentSet && previous.appointmentSetTracked) {
      await setStageFieldTimestamp(personId, APPOINTMENT_SET_FIELD, "");
    }

    if (webhookUrl && isRegression) {
      const text =
        `<!channel> ⬅️ *Stage regression:* ${name} moved from *${previous.stage}* back to *${newStage}* — ` +
        `<https://power.followupboss.com/2/people/view/${personId}|Open in FUB>`;
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => {});
    }

    if (metReminderWebhook && isMet) {
      const text =
        `<!channel> 🎥 *${name}* moved to *Recruiting - Met* — remember to move their Meet transcript ` +
        `into the shared Drive folder for the Weekly Report. ` +
        `<https://power.followupboss.com/2/people/view/${personId}|Open in FUB>`;
      await fetch(metReminderWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => {});
    }

    newChanges.push({ personId, agent, name, stage: newStage, rank: newRank, at });
    current[personId] = { stage: newStage, rank: newRank, at, attemptedContactTracked, appointmentSetTracked };
  }

  await stageStore.setJSON("current", current);
  await changesStore.setJSON("events", [...changes, ...newChanges]);

  return { statusCode: 200, body: "ok" };
};
