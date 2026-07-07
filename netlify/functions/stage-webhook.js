// Receives FUB's "peopleStageUpdated" webhook. The payload only carries the
// new stage name (no previous value — confirmed via FUB docs), so the last
// known stage per person is kept in Blobs to detect when a lead moves
// backward (a strong "this deal may be falling apart" signal). Every change
// is also appended to a log that weekly-leaderboard.js reads to rank agents.
const { getStore } = require("@netlify/blobs");

// Most-advanced first — mirrors PIPELINE_STAGES in fub_streamlit.py.
const STAGE_RANK = {
  "Under Contract":    0,
  "Submitting Offers": 1,
  "Showing Homes":     2,
  "Appointment Set":   3,
  "Met With":          4,
  "Spoke With":        5,
  "Attempted Contact": 6,
  "Lead":              7,
};

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
  const newChanges = [];

  for (const personId of personIds) {
    const previous = current[personId];
    const isRegression =
      previous && previous.rank !== null && newRank !== null && newRank > previous.rank;

    const person = newRank !== null || isRegression ? await fetchPerson(personId) : null;
    const agent = person && person.assignedTo;
    const name = person
      ? `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`
      : `Lead #${personId}`;

    if (webhookUrl && isRegression) {
      const text =
        `⬅️ *Stage regression:* ${name} moved from *${previous.stage}* back to *${newStage}* — ` +
        `<https://power.followupboss.com/2/people/view/${personId}|Open in FUB>`;
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => {});
    }

    newChanges.push({ personId, agent, name, stage: newStage, rank: newRank, at });
    current[personId] = { stage: newStage, rank: newRank, at };
  }

  await stageStore.setJSON("current", current);
  await changesStore.setJSON("events", [...changes, ...newChanges]);

  return { statusCode: 200, body: "ok" };
};
