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
//   digest/<YYYY-MM-DD>    the managers' daily digest went out that day
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

// Who gets check-ins: FUB user names or ids, comma-separated ("all" = everyone).
// CHECKIN_PILOT overrides the default pilot group.
const PILOT = process.env.CHECKIN_PILOT || "Diego Clavel, Ruben Aguila, George Hernandez, Stephanie Haines, Jeffery Mcgonigle";
// Managers who get the daily list of unanswered check-ins.
const DIGEST_TO = process.env.CHECKIN_DIGEST_TO || "David Gómez, Jeffery Mcgonigle";

const normName = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

// FUB user ids for a comma-separated list of names or ids; logs names with no match.
async function resolveUsers(list) {
  const wanted = list.split(",").map((s) => s.trim()).filter(Boolean);
  const users = wanted.every((w) => /^\d+$/.test(w)) ? [] : await fubList("/users?limit=100", "users");
  const ids = [];
  for (const w of wanted) {
    if (/^\d+$/.test(w)) ids.push(Number(w));
    else {
      const u = users.find((x) => normName(x.name) === normName(w));
      if (u) ids.push(u.id);
      else console.warn(`Check-in: no FUB user named "${w}"`);
    }
  }
  return ids;
}

let pilotIds;
async function inPilot(userId) {
  if (PILOT.trim().toLowerCase() === "all") return true;
  pilotIds = pilotIds || resolveUsers(PILOT);
  return (await pilotIds).includes(Number(userId));
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

// FUB's appointment outcomes and types. The list key isn't consistently cased
// across FUB endpoints, so take whichever array the response carries.
async function fubAnyList(path, what) {
  const data = await fub(path);
  const list = Object.entries(data).find(([k, v]) => k !== "_metadata" && Array.isArray(v));
  const items = ((list && list[1]) || []).filter((o) => o && o.id && o.name);
  if (!items.length) console.warn(`Check-in: no ${what} from FUB (keys: ${Object.keys(data).join(",")})`);
  return items;
}
const fubOutcomes = () => fubAnyList("/appointmentOutcomes?limit=100", "appointment outcomes");
const fubApptTypes = () => fubAnyList("/appointmentTypes?limit=100", "appointment types");

// "2026-10-31" + "14:00" in Pacific time -> ISO timestamp.
function pacificISO(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const tz = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(guess).find((p) => p.type === "timeZoneName").value;
  return new Date(`${date}T${time}:00${tz.replace("GMT", "") || "+00:00"}`).toISOString();
}

const NOT_MET = /no.?show|not met|didn.?t|resched|cancel/i;

// Stages a check-in may move a sales lead to, in pipeline order. Power and
// Zillow leads share the same sales stages (all synced with Zillow); recruiting
// stages are a separate pipeline. After an appointment a lead only moves
// forward, so the earlier stages (Lead … Appointment Set) and Closed/Trash
// are left out.
const CHECKIN_STAGES = [
  "met with customer", "showing homes", "submitting offers", "listing agreement",
  "under contract", "active listing", "nurture",
];

// FUB's spelling of those stages, in the order above.
async function checkinStages() {
  const names = (await fubList("/stages?limit=100", "stages")).map((s) => s.name);
  return CHECKIN_STAGES.map((want) => names.find((n) => n.trim().toLowerCase() === want)).filter(Boolean);
}

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
  await sendDigest({ now, log });
}

// Returns true when a DM went out. `agentUserId` (the "test" DM) asks that
// agent directly and skips the pilot gate.
async function askAboutAppointment(appt, { agentUserId, log = console.log } = {}) {
  const store = checkinStore();
  const invitees = appt.invitees || [];
  const leadInv = invitees.find((i) => i.personId);
  const agents = invitees.filter((i) => i.userId);
  if (!leadInv || !agents.length) return false;
  if (!agentUserId && !(await Promise.all(agents.map((a) => inPilot(a.userId)))).some(Boolean)) return false;

  const person = await fub(`/people/${leadInv.personId}`);
  // Ask the lead's own agent when they're on the invite; otherwise the first agent.
  const agentInv = agentUserId
    ? agents.find((a) => a.userId === agentUserId)
    : agents.find((a) => a.userId === person.assignedUserId) || agents[0];
  if (!agentInv || (!agentUserId && !(await inPilot(agentInv.userId)))) return false;
  // InterFace recruiting appointments often have no type; the lead's stage tells.
  if (!agentUserId && SKIP_TYPES.test(person.stage || "")) {
    await store.setJSON(`appt/${appt.id}`, { status: "skipped_recruiting", at: Date.now() });
    return false;
  }
  const agent = await slackUserFor(agentInv.userId);
  if (!agent) {
    await store.setJSON(`appt/${appt.id}`, { status: "no_slack", at: Date.now() });
    return false;
  }

  const leadName = person.name || leadInv.name || `Lead #${leadInv.personId}`;
  // Buttons: where the lead stands now (sales stages from Met with customer
  // up), plus FUB's "didn't happen" outcomes (Rescheduled, Canceled/No Show).
  const [stages, outcomes] = await Promise.all([checkinStages(), fubOutcomes()]);
  let notMet = outcomes.filter((o) => NOT_MET.test(o.name));
  if (!notMet.length) notMet = [{ id: "notmet", name: "Didn't happen / Reschedule" }];
  const buttons = [
    ...stages.map((name, i) => ({ actionId: `stage:${i}`, name })),
    ...notMet.map((o) => ({ actionId: `outcome:${o.id}`, name: o.name })),
  ];
  const dm = await slack("conversations.open", { users: agent.slackId });
  const channel = dm.channel.id;
  const what = appt.type ? `*${appt.type}*` : "appointment";
  const msg = await slack("chat.postMessage", {
    channel,
    text: `<@${agent.slackId}> How did your appointment with ${leadName} go?`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `👋 Hi <@${agent.slackId}>! How did your ${what} with *${leadName}* go? (${fmtTime(appt.start)})\nTap one, or just reply here in your own words (or a voice clip): how it went and what's next.`,
        },
      },
      {
        type: "actions",
        block_id: `outcome:${appt.id}`,
        elements: [
          ...buttons.map((o) => ({
            type: "button",
            text: { type: "plain_text", text: o.name.slice(0, 70) },
            action_id: o.actionId,
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
      text: `<@${rec.agent.slackId}> Quick reminder: how did it go with *${rec.person.name}*? A one-line answer is plenty, I'll log it in FUB for you.`,
    });
    await store.setJSON(`appt/${id}`, { ...rec, remindedAt: now });
    log(`Check-in: reminded ${rec.agent.name} about appointment ${id}`);
  }
}

// Daily at 6 PM PT: DM the managers every check-in still waiting on an agent
// (no answer, mid-conversation, or drafted but never saved), by agent.
// Skipped on days with nothing pending.
async function sendDigest({ now = Date.now(), log = console.log } = {}) {
  const hour = Number(new Date(now).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hour12: false }));
  if (hour !== 18) return;
  const store = checkinStore();
  const day = new Date(now).toLocaleDateString("en-CA", { timeZone: TZ });
  if (await store.get(`digest/${day}`)) return;
  await store.set(`digest/${day}`, String(now));

  const { blobs } = await store.list({ prefix: "open/" });
  const byAgent = {};
  for (const { key } of blobs) {
    const rec = await store.get(`appt/${key.slice(5)}`, { type: "json" });
    if (!rec || rec.status === "saved" || !rec.agent) continue;
    const state = rec.status === "planned" ? "drafted, not saved" : rec.transcript.length ? "started, not finished" : "no answer";
    const hours = Math.round((now - rec.askedAt) / 3600e3);
    (byAgent[rec.agent.name] = byAgent[rec.agent.name] || []).push(
      `• <${FUB_APP}/2/people/view/${rec.person.id}|${rec.person.name}> (appt ${fmtTime(rec.appt.start)}): ${state}, asked ${hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`} ago`
    );
  }
  const agents = Object.keys(byAgent).sort();
  if (!agents.length) return log("Check-in digest: nothing pending");
  const total = agents.reduce((n, a) => n + byAgent[a].length, 0);
  const text = `📋 *Appointment check-ins still open: ${total}*\nThese aren't logged in FUB yet.\n\n${agents
    .map((a) => `*${a}* (${byAgent[a].length})\n${byAgent[a].join("\n")}`)
    .join("\n\n")}`;

  for (const fubUserId of await resolveUsers(DIGEST_TO)) {
    const to = await slackUserFor(fubUserId);
    if (!to) continue;
    const dm = await slack("conversations.open", { users: to.slackId });
    await slack("chat.postMessage", { channel: dm.channel.id, text, unfurl_links: false });
  }
  log(`Check-in digest: ${total} open check-ins sent`);
}

// ---------- Plan: turn the agent's answer into FUB updates ----------

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "ready", "outcomeId", "note", "stage", "appointment", "task"],
  properties: {
    reply: { type: "string", description: "Slack message to the agent: a short follow-up question, or a one-line intro to the plan when ready." },
    ready: { type: "boolean", description: "true when there's enough to log the appointment." },
    outcomeId: { type: ["integer", "null"], description: "Appointment outcome id from the list, or null if unclear." },
    note: { type: "string", description: "FUB note recapping the appointment in the agent's words, third person, 1-4 sentences. Empty if not ready." },
    stage: { type: ["string", "null"], description: "New FUB stage name from the list, only if the agent's answer clearly moves the lead; else null." },
    appointment: {
      type: ["object", "null"],
      description: "Next meeting with the lead to create in FUB, only with an exact date and time from the agent; else null.",
      additionalProperties: false,
      required: ["title", "date", "time", "minutes", "typeId", "location"],
      properties: {
        title: { type: "string", description: "e.g. Showing: 3 homes in Riverside" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "Start, 24-hour HH:MM, Pacific time" },
        minutes: { type: "integer", description: "Length in minutes; 60 unless the agent said otherwise" },
        typeId: { type: ["integer", "null"], description: "Appointment type id from the list, or null" },
        location: { type: ["string", "null"] },
      },
    },
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

- Ask at most one short follow-up question at a time, and only for what's missing: how it went (outcome) and the next step. After three follow-ups, or if the agent says that's all, set ready=true with what you have.
- appointment: when the next step is meeting the lead at a set time (a showing, a listing appointment, another meeting or call with them), it goes on the FUB calendar, so you need the exact day and start time. If the agent was vague ("next weekend", "Saturday", "in the afternoon"), ask for the exact day and time before setting ready (for a showing, also the area or address if they didn't say). Work out dates like "this Saturday" from today. Never guess a day or time. If the agent doesn't know yet, appointment is null and the task is to schedule it. Pick typeId from the appointment types when one clearly fits. Don't add a task for the same thing as the appointment.
- Never invent facts. The note uses only what the agent said, written in third person ("Agent reports…").
- outcomeId is only for an appointment that didn't happen; if it happened, outcomeId is null.
- If the agent tapped a stage ("Picked stage: …"), the appointment happened and that's the stage unless they explicitly ask for a different one. A showing that is only planned doesn't make it Showing Homes.
- If the appointment didn't happen (no-show, cancelled, rescheduled): outcomeId is the matching outcome if one exists, else null; stage stays null (no change); the note says it didn't happen and why, in the agent's words; the task is to reschedule (or the new date if they gave one).
- stage: only when the answer clearly moves the lead forward, and only to an exact name from the stage list: met and still working it → Met with customer; out looking at homes → Showing Homes; writing offers → Submitting Offers; signed a listing → Listing agreement; in escrow → Under Contract; listing is live → Active Listing; not ready / long-term → Nurture. Otherwise null.
- task: the agent's next step with a realistic due date (default 2 business days if they gave none). null if there's no next step.
- reply: friendly, plain, at most 2 sentences, in the language the agent wrote in. When ready, just say you've drafted it and they can tap Save or reply with changes; the plan itself is shown separately.`;

async function draftPlan(rec) {
  const [allOutcomes, stages, types] = await Promise.all([fubOutcomes(), checkinStages(), fubApptTypes()]);
  // The "Met- …" outcomes add nothing over the stage, so only a didn't-happen
  // outcome is ever logged on the appointment.
  const outcomes = allOutcomes.filter((o) => NOT_MET.test(o.name));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const weekday = new Date().toLocaleDateString("en-US", { timeZone: TZ, weekday: "long" });
  const context = {
    today: `${today} (${weekday})`,
    appointment: { type: rec.appt.type, title: rec.appt.title, start: fmtTime(rec.appt.start), location: rec.appt.location },
    lead: { name: rec.person.name, currentStage: rec.person.stage },
    agent: rec.agent.name,
    outcomes: outcomes.map((o) => ({ id: o.id, name: o.name })),
    stages,
    appointmentTypes: types.map((t) => ({ id: t.id, name: t.name })),
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
  // A stage the agent tapped wins, unless they later named a different stage
  // themselves. Upcoming showings don't move the lead to Showing Homes.
  const pickAt = rec.transcript.map((m) => m.from === "Agent" && /^Picked stage: /.test(m.text)).lastIndexOf(true);
  if (pickAt >= 0) {
    const picked = rec.transcript[pickAt].text.replace(/^Picked stage: /, "");
    const later = rec.transcript.slice(pickAt + 1).filter((m) => m.from === "Agent").map((m) => m.text.toLowerCase()).join(" ");
    // "showing homes next weekend" names a stage by accident, so it only counts
    // as a change when they also say stage/move/change/put/set.
    const asked = /\b(stage|move|change|put|set|update)\b/.test(later) && stages.some((s) => s !== picked && later.includes(s.toLowerCase()));
    if (stages.includes(picked) && !(asked && plan.stage)) plan.stage = picked;
  }
  if (plan.stage === rec.person.stage) plan.stage = null;
  plan.outcomeName = (outcomes.find((o) => o.id === plan.outcomeId) || {}).name || null;
  const a = plan.appointment;
  if (a) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(a.date) && /^\d{2}:\d{2}$/.test(a.time)) {
      a.start = pacificISO(a.date, a.time);
      a.end = new Date(Date.parse(a.start) + (a.minutes > 0 ? a.minutes : 60) * 60e3).toISOString();
      if (a.typeId != null && !types.some((t) => t.id === a.typeId)) a.typeId = null;
      a.typeName = (types.find((t) => t.id === a.typeId) || {}).name || null;
    }
    if (!a.start || Date.parse(a.start) < Date.now()) plan.appointment = null;
  }
  return plan;
}

function planBlocks(rec, plan, planId) {
  const lines = [];
  if (plan.outcomeName) lines.push(`• *Outcome:* ${plan.outcomeName}`);
  if (plan.note) lines.push(`• *Note:* ${plan.note}`);
  if (plan.stage) lines.push(`• *Stage:* ${rec.person.stage || "—"} → *${plan.stage}*`);
  if (plan.appointment) {
    const a = plan.appointment;
    const when = new Date(a.start).toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
    lines.push(`• *Appointment:* ${a.title} · ${when} (${Math.round((Date.parse(a.end) - Date.parse(a.start)) / 60e3)} min)${a.typeName ? ` · ${a.typeName}` : ""}${a.location ? ` · ${a.location}` : ""}`);
  }
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
  // Steps already saved stay in rec.saved, so tapping Save again after a
  // failure finishes the rest without duplicating the note or task.
  const done = (rec.saved = rec.saved || []);
  if (plan.note && !done.includes("note")) {
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
  if (plan.outcomeId && !done.includes("outcome")) {
    // FUB rejects an appointment update without its start and end.
    const appt = await fub(`/appointments/${rec.appt.id}`);
    await fub(`/appointments/${rec.appt.id}`, {
      method: "PUT",
      body: JSON.stringify({ title: appt.title, start: appt.start, end: appt.end, outcomeId: plan.outcomeId }),
    });
    done.push("outcome");
  }
  if (plan.stage && !done.includes("stage")) {
    await fub(`/people/${personId}`, { method: "PUT", body: JSON.stringify({ stage: plan.stage }) });
    done.push("stage");
  }
  if (plan.appointment && !done.includes("appointment")) {
    const a = plan.appointment;
    await fub("/appointments", {
      method: "POST",
      body: JSON.stringify({
        title: a.title,
        start: a.start,
        end: a.end,
        ...(a.typeId ? { typeId: a.typeId } : {}),
        ...(a.location ? { location: a.location } : {}),
        invitees: [{ personId }, { userId: rec.agent.fubUserId }],
      }),
    });
    done.push("appointment");
  }
  if (plan.task && !done.includes("task")) {
    await fub("/tasks", {
      method: "POST",
      body: JSON.stringify({ personId, assignedUserId: rec.agent.fubUserId, name: plan.task.name, type: plan.task.type, dueDate: plan.task.dueDate }),
    });
    done.push("task");
  }
  return done;
}

// Who the pilot and digest lists resolve to in FUB, for the "pilot" DM.
async function pilotReport() {
  const users = await fubList("/users?limit=100", "users");
  const show = (list) =>
    list.split(",").map((s) => s.trim()).filter(Boolean).map((w) => {
      const u = users.find((x) => String(x.id) === w || normName(x.name) === normName(w));
      return u ? `✅ ${u.name} (FUB ${u.id})` : `❌ "${w}" not found in FUB`;
    }).join("\n");
  return `*Check-ins go to:*\n${PILOT.trim().toLowerCase() === "all" ? "everyone" : show(PILOT)}\n\n*Daily digest goes to:*\n${show(DIGEST_TO)}`;
}

module.exports = {
  pilotReport,
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
