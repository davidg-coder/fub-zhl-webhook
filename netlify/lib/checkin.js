// Post-appointment check-ins: an hour after a FUB appointment ends, Claudio
// DMs the agent on Slack ("How did it go with Maria?"). The agent taps an
// outcome or replies in their own words; Claude turns that into a plan (note,
// appointment outcome, stage, follow-up task) and nothing is written to FUB
// until the agent taps Save.
//
// Records live in the "claudio-checkins" blob store:
//   appt/<appointmentId>   the check-in (appointment, lead, agent, thread, plan)
//   open/<appointmentId>   index of check-ins still waiting on the agent
//   thread/<channel>/<ts>  Slack thread -> appointmentId
//   agent/<slackUserId>    the agent's latest open check-in, for replies
//                          typed outside the thread
//   slack/<fubUserId>      cached Slack user id for a FUB user
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");
const Anthropic = require("@anthropic-ai/sdk");
const { fub } = require("./claudio-skills");

const MODEL = process.env.CLAUDIO_MODEL || "claude-opus-5-5";
const TZ = "America/Los_Angeles";
// Appointment types that belong to recruiting (InterFace), not sales.
const SKIP_TYPES = new RegExp(process.env.CHECKIN_SKIP_TYPES || "discovery|consultation|recruit", "i");
const FUB_APP = "https://power.followupboss.com";

const checkinStore = () =>
  getStore({ name: "claudio-checkins", siteID: process.env.SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN, consistency: "strong" });

// FUB user ids in the pilot ("all" = everyone). Empty means nobody gets pinged.
function inPilot(userId) {
  const list = (process.env.CHECKIN_PILOT_USER_IDS || "").trim();
  if (list.toLowerCase() === "all") return true;
  return list.split(",").map((s) => Number(s.trim())).includes(Number(userId));
}

// ---------- Slack ----------

async function slack(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

async function slackGet(method, params) {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

// Slack signs every request with the app's signing secret; requests older
// than 5 minutes are rejected so a captured one can't be replayed.
function verifySlack(rawBody, headers) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  const ts = headers["x-slack-request-timestamp"];
  const sig = headers["x-slack-signature"] || "";
  if (!secret || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function slackUserFor(fubUserId) {
  const store = checkinStore();
  const cached = await store.get(`slack/${fubUserId}`, { type: "json" });
  if (cached) return cached;
  const user = await fub(`/users/${fubUserId}`);
  if (!user.email) return null;
  let slackId;
  try {
    slackId = (await slackGet("users.lookupByEmail", { email: user.email })).user.id;
  } catch (err) {
    console.warn(`Check-in: no Slack user for FUB user ${fubUserId} (${err.message})`);
    return null;
  }
  const entry = { slackId, name: user.name, firstName: user.firstName || String(user.name || "").split(" ")[0] };
  await store.setJSON(`slack/${fubUserId}`, entry);
  return entry;
}

// ---------- FUB ----------

async function fubList(path, key) {
  const out = [];
  let url = path;
  for (let page = 0; url && page < 10; page++) {
    const data = await fub(url);
    out.push(...(data[key] || []));
    // Deep offset paging is disabled on this account; follow the cursor.
    const next = data._metadata && data._metadata.nextLink;
    url = next ? next.replace(/^https:\/\/api\.followupboss\.com\/v1/, "") : null;
  }
  return out;
}

// FUB's appointment outcomes. The list key isn't consistently cased across FUB
// endpoints, so take whichever array the response carries.
async function fubOutcomes() {
  const data = await fub("/appointmentOutcomes?limit=100");
  const list = Object.entries(data).find(([k, v]) => k !== "_metadata" && Array.isArray(v));
  const outcomes = ((list && list[1]) || []).filter((o) => o && o.id && o.name);
  if (!outcomes.length) console.warn(`Check-in: no appointment outcomes from FUB (keys: ${Object.keys(data).join(",")})`);
  return outcomes;
}

// Shown when FUB has no outcomes set up; the choice only goes to Claude.
const FALLBACK_OUTCOMES = ["Met", "No-show", "Rescheduled", "Cancelled"];

const fmtTime = (iso) =>
  new Date(iso).toLocaleString("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" });

// ---------- Scan: find appointments that ended and ask ----------

async function scanAndAsk({ now = Date.now(), log = console.log } = {}) {
  if (!process.env.SLACK_BOT_TOKEN) return log("Check-in: SLACK_BOT_TOKEN not set, skipping");
  const store = checkinStore();
  const from = new Date(now - 12 * 3600e3).toISOString();
  const to = new Date(now - 60 * 60e3).toISOString();
  const appts = await fubList(`/appointments?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}&limit=100`, "appointments");
  let asked = 0;
  for (const appt of appts) {
    const end = Date.parse(appt.end || appt.start);
    if (appt.allDay || !(end <= now - 60 * 60e3) || end < now - 12 * 3600e3) continue;
    if (appt.outcomeId || appt.outcome) continue;
    if (SKIP_TYPES.test(appt.type || "") || SKIP_TYPES.test(appt.title || "")) continue;
    if (await store.get(`appt/${appt.id}`)) continue;
    try {
      if (await askAboutAppointment(appt, { log })) asked++;
    } catch (err) {
      console.error(`Check-in: appointment ${appt.id} failed:`, err.message);
    }
  }
  log(`Check-in scan: ${appts.length} appointments in window, ${asked} agents asked`);
  await remindOpen({ now, log });
}

// Returns true when a DM went out. `agentUserId` (the "test" DM) asks that
// agent directly and skips the pilot gate.
async function askAboutAppointment(appt, { agentUserId, log = console.log } = {}) {
  const store = checkinStore();
  const invitees = appt.invitees || [];
  const leadInv = invitees.find((i) => i.personId);
  const agents = invitees.filter((i) => i.userId);
  if (!leadInv || !agents.length) return false;
  if (!agentUserId && !agents.some((a) => inPilot(a.userId))) return false;

  const person = await fub(`/people/${leadInv.personId}`);
  // Ask the lead's own agent when they're on the invite; otherwise the first agent.
  const agentInv = agentUserId
    ? agents.find((a) => a.userId === agentUserId)
    : agents.find((a) => a.userId === person.assignedUserId) || agents[0];
  if (!agentInv || (!agentUserId && !inPilot(agentInv.userId))) return false;
  const agent = await slackUserFor(agentInv.userId);
  if (!agent) {
    await store.setJSON(`appt/${appt.id}`, { status: "no_slack", at: Date.now() });
    return false;
  }

  const leadName = person.name || leadInv.name || `Lead #${leadInv.personId}`;
  const outcomes = await fubOutcomes();
  const dm = await slack("conversations.open", { users: agent.slackId });
  const channel = dm.channel.id;
  const what = appt.type ? `*${appt.type}*` : "appointment";
  const msg = await slack("chat.postMessage", {
    channel,
    text: `How did your appointment with ${leadName} go?`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `👋 Hi ${agent.firstName}! How did your ${what} with *${leadName}* go? (${fmtTime(appt.start)})\nTap one, or just reply here in your own words (or a voice clip): how it went and what's next.`,
        },
      },
      {
        type: "actions",
        block_id: `outcome:${appt.id}`,
        elements: [
          ...(outcomes.length ? outcomes.slice(0, 10) : FALLBACK_OUTCOMES.map((name, i) => ({ id: `x${i}`, name }))).map((o) => ({
            type: "button",
            text: { type: "plain_text", text: o.name.slice(0, 70) },
            action_id: `outcome:${o.id}`,
            value: JSON.stringify({ appt: appt.id }),
          })),
          { type: "button", text: { type: "plain_text", text: "Open in FUB" }, url: `${FUB_APP}/2/people/view/${person.id}`, action_id: "open_fub" },
        ],
      },
    ],
  });

  const record = {
    status: "asked",
    askedAt: Date.now(),
    appt: { id: appt.id, type: appt.type, title: appt.title, start: appt.start, end: appt.end, location: appt.location },
    person: { id: person.id, name: leadName, stage: person.stage, assignedUserId: person.assignedUserId },
    agent: { fubUserId: agentInv.userId, slackId: agent.slackId, name: agent.name, firstName: agent.firstName },
    channel,
    ts: msg.ts,
    transcript: [],
  };
  await Promise.all([
    store.setJSON(`appt/${appt.id}`, record),
    store.set(`open/${appt.id}`, String(Date.now())),
    store.set(`thread/${channel}/${msg.ts}`, String(appt.id)),
    store.set(`agent/${agent.slackId}`, String(appt.id)),
  ]);
  log(`Check-in: asked ${agent.name} about appointment ${appt.id} with ${leadName}`);
  return true;
}

// One nudge the next working morning when an agent hasn't answered.
async function remindOpen({ now = Date.now(), log = console.log } = {}) {
  const hour = Number(new Date(now).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hour12: false }));
  if (hour < 9 || hour >= 18) return;
  const store = checkinStore();
  const { blobs } = await store.list({ prefix: "open/" });
  for (const { key } of blobs) {
    const id = key.slice(5);
    const rec = await store.get(`appt/${id}`, { type: "json" });
    if (!rec || rec.status === "saved") {
      await store.delete(key);
      continue;
    }
    const age = now - rec.askedAt;
    if (age > 7 * 24 * 3600e3) {
      await store.delete(key);
      continue;
    }
    if (rec.remindedAt || rec.transcript.length || age < 16 * 3600e3) continue;
    await slack("chat.postMessage", {
      channel: rec.channel,
      thread_ts: rec.ts,
      text: `Quick reminder: how did it go with *${rec.person.name}*? A one-line answer is plenty, I'll log it in FUB for you.`,
    });
    await store.setJSON(`appt/${id}`, { ...rec, remindedAt: now });
    log(`Check-in: reminded ${rec.agent.name} about appointment ${id}`);
  }
}

// ---------- Plan: turn the agent's answer into FUB updates ----------

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "ready", "outcomeId", "note", "stage", "task"],
  properties: {
    reply: { type: "string", description: "Slack message to the agent: a short follow-up question, or a one-line intro to the plan when ready." },
    ready: { type: "boolean", description: "true when there's enough to log the appointment." },
    outcomeId: { type: ["integer", "null"], description: "Appointment outcome id from the list, or null if unclear." },
    note: { type: "string", description: "FUB note recapping the appointment in the agent's words, third person, 1-4 sentences. Empty if not ready." },
    stage: { type: ["string", "null"], description: "New FUB stage name from the list, only if the agent's answer clearly moves the lead; else null." },
    task: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["name", "dueDate", "type"],
      properties: {
        name: { type: "string" },
        dueDate: { type: "string", description: "YYYY-MM-DD" },
        type: { type: "string", enum: ["Follow Up", "Call", "Text", "Email", "Appointment", "Showing"] },
      },
    },
  },
};

const PLAN_PROMPT = `You are Claudio, the assistant for Power Real Estate Group agents. An agent just had an appointment with a lead and is telling you how it went over Slack. Turn what they say into updates for Follow Up Boss.

- Ask at most one short follow-up question at a time, and only for what's missing: how it went (outcome) and the next step. After two follow-ups, or if the agent says that's all, set ready=true with what you have.
- Never invent facts. The note uses only what the agent said, written in third person ("Agent reports…").
- stage: only when the answer clearly moves the lead (e.g. signed a listing or buyer agreement, wrote an offer, lost/not interested). Must be an exact name from the stage list. Otherwise null.
- task: the agent's next step with a realistic due date (default 2 business days if they gave none). null if there's no next step.
- reply: friendly, plain, at most 2 sentences, in the language the agent wrote in. When ready, just say you've drafted it and they can tap Save or reply with changes; the plan itself is shown separately.`;

async function draftPlan(rec) {
  const [outcomes, stages] = await Promise.all([
    fubOutcomes(),
    fub("/stages?limit=100").then((d) => (d.stages || []).map((s) => s.name)),
  ]);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const context = {
    today,
    appointment: { type: rec.appt.type, title: rec.appt.title, start: fmtTime(rec.appt.start), location: rec.appt.location },
    lead: { name: rec.person.name, currentStage: rec.person.stage },
    agent: rec.agent.name,
    outcomes: outcomes.map((o) => ({ id: o.id, name: o.name })),
    stages,
  };
  const messages = [
    {
      role: "user",
      content: `${JSON.stringify(context)}\n\nConversation so far:\n${rec.transcript.map((t) => `${t.from}: ${t.text}`).join("\n")}`,
    },
  ];
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: PLAN_SCHEMA } },
    system: PLAN_PROMPT,
    messages,
  });
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const plan = JSON.parse(text);
  if (plan.outcomeId != null && !outcomes.some((o) => o.id === plan.outcomeId)) plan.outcomeId = null;
  if (plan.stage && !stages.includes(plan.stage)) plan.stage = null;
  if (plan.stage === rec.person.stage) plan.stage = null;
  plan.outcomeName = (outcomes.find((o) => o.id === plan.outcomeId) || {}).name || null;
  return plan;
}

function planBlocks(rec, plan, planId) {
  const lines = [];
  if (plan.outcomeName) lines.push(`• *Outcome:* ${plan.outcomeName}`);
  if (plan.note) lines.push(`• *Note:* ${plan.note}`);
  if (plan.stage) lines.push(`• *Stage:* ${rec.person.stage || "—"} → *${plan.stage}*`);
  if (plan.task) lines.push(`• *Task:* ${plan.task.type}: ${plan.task.name} (due ${plan.task.dueDate})`);
  return [
    { type: "section", text: { type: "mrkdwn", text: plan.reply } },
    { type: "section", text: { type: "mrkdwn", text: `*For ${rec.person.name} in FUB:*\n${lines.join("\n")}` } },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "✅ Save to FUB" }, action_id: "save", value: JSON.stringify({ appt: rec.appt.id, planId }) },
      ],
    },
    { type: "context", elements: [{ type: "mrkdwn", text: "Want something different? Just reply and I'll redo it." }] },
  ];
}

// Every write runs on the shared key, so it's limited to this check-in's lead
// and only after the agent who was asked taps Save on this exact plan.
async function applyPlan(rec) {
  const { plan } = rec;
  const personId = rec.person.id;
  const done = [];
  if (plan.note) {
    // The full Slack exchange goes in too, so the record lives in FUB and not
    // only in a DM nobody else can see.
    const convo = rec.transcript.map((t) => `${t.from === "Agent" ? rec.agent.name : "Claudio"}: ${t.text}`).join("\n");
    await fub("/notes", {
      method: "POST",
      body: JSON.stringify({
        personId,
        subject: `Appointment recap${rec.appt.type ? ` (${rec.appt.type})` : ""}`,
        body: `${plan.note}\n\n— logged by ${rec.agent.name} via Claudio\n\nConversation:\n${convo}`,
      }),
    });
    done.push("note");
  }
  if (plan.outcomeId) {
    await fub(`/appointments/${rec.appt.id}`, { method: "PUT", body: JSON.stringify({ outcomeId: plan.outcomeId }) });
    done.push("outcome");
  }
  if (plan.stage) {
    await fub(`/people/${personId}`, { method: "PUT", body: JSON.stringify({ stage: plan.stage }) });
    done.push("stage");
  }
  if (plan.task) {
    await fub("/tasks", {
      method: "POST",
      body: JSON.stringify({ personId, assignedUserId: rec.agent.fubUserId, name: plan.task.name, type: plan.task.type, dueDate: plan.task.dueDate }),
    });
    done.push("task");
  }
  return done;
}

module.exports = {
  checkinStore,
  slack,
  slackGet,
  verifySlack,
  scanAndAsk,
  askAboutAppointment,
  fubList,
  draftPlan,
  planBlocks,
  applyPlan,
  FUB_APP,
};
