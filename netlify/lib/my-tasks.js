// Meeting task tracker for David: every weekday morning it reads the Google
// Meet notes and transcripts in his Drive (his own and the ones shared with
// him), asks Claude for the action items that are HIS, and DMs him every open
// task with ✅ Done / Not mine buttons. A task keeps showing up each morning
// until he taps one of them.
//
// Drive access is David's own OAuth (the same Google client and refresh token
// as the Prep Hub Meet setup, fub-zillow-bot/meet_oauth_token.json; needs the
// drive.readonly scope). Env: MY_TASKS_GOOGLE_CLIENT_ID, MY_TASKS_GOOGLE_CLIENT_SECRET,
// MY_TASKS_GOOGLE_REFRESH_TOKEN.
//
// Records live in the "my-tasks" blob store:
//   file/<driveFileId>   that meeting doc was already analyzed
//   task/<taskId>        one task (status open | done | dismissed)
//   sent/<YYYY-MM-DD>    that day's reminder went out
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");
const Anthropic = require("@anthropic-ai/sdk");
const { slack, slackGet } = require("./checkin");
const { addUsage, emptyUsage, logUsage, pacificDay } = require("./usage-log");

const MODEL = process.env.MY_TASKS_MODEL || "claude-sonnet-5-5";
const OWNER_EMAIL = process.env.MY_TASKS_EMAIL || "davidg@powerreteam.com";
// How far back to look for meeting docs. Docs already analyzed are skipped,
// so this only matters on the first run or after an outage.
const LOOKBACK_DAYS = Number(process.env.MY_TASKS_LOOKBACK_DAYS || 7);
const MAX_DOC_CHARS = 200000;
const TASKS_PER_MESSAGE = 20; // 2 blocks per task, Slack allows 50 per message

const store = () =>
  getStore({ name: "my-tasks", siteID: process.env.SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN, consistency: "strong" });

// ---------- Google Drive ----------

async function googleToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: process.env.MY_TASKS_GOOGLE_CLIENT_ID || "",
      client_secret: process.env.MY_TASKS_GOOGLE_CLIENT_SECRET || "",
      refresh_token: process.env.MY_TASKS_GOOGLE_REFRESH_TOKEN || "",
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Google token: ${data.error || res.status} ${data.error_description || ""}`.trim());
  return data.access_token;
}

async function drive(token, path, params) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return params.mimeType ? res.text() : res.json();
}

// Gemini "Notes by Gemini" docs and Meet "Transcript" docs, owned by David or
// shared with him, touched in the lookback window.
async function meetingDocs(token) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString();
  const q = [
    "mimeType='application/vnd.google-apps.document'",
    "trashed=false",
    `modifiedTime > '${since}'`,
    "(name contains 'Notes by Gemini' or name contains 'Transcript')",
  ].join(" and ");
  const files = [];
  let pageToken;
  do {
    const data = await drive(token, "files", {
      q,
      pageSize: 200,
      fields: "nextPageToken,files(id,name,createdTime,webViewLink,owners(displayName))",
      ...(pageToken ? { pageToken } : {}),
    });
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

// ---------- Claude ----------

const TASKS_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task: { type: "string" },
          due: { type: ["string", "null"] },
          requestedBy: { type: ["string", "null"] },
          evidence: { type: "string" },
        },
        required: ["task", "due", "requestedBy", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
};

const TASKS_PROMPT = `You read Google Meet notes and transcripts and pull out the action items that belong to ONE person: David Gómez (${OWNER_EMAIL}). David runs automation and ops tooling at Power Real Estate Group: n8n workflows, Follow Up Boss (FUB) setup and integrations, Slack bots, dashboards, the Power Portal, Lovable apps, Zillow/ISA/recruiting reports.

Include a task only when David owns it:
- A "Next steps" line tagged with him ([David Gómez], [David Gomez], [David G], [David]).
- Someone in the transcript clearly asks David to do something, or David commits to doing it ("I'll build…", "let me check…", "I'll send you…").
- A "[The group]" or unassigned item only if the transcript shows David taking it on.

Leave out:
- Other people named David (e.g. a recruiting candidate like "David Layton"). If you can't tell whether a "David" is David Gómez, leave it out.
- Tasks for anyone else, things already finished during the meeting, FYIs, and vague ideas nobody agreed to do.
- Tasks already on David's open list (given below), even if worded differently.

For each task:
- task: one short imperative sentence in English, specific enough to act on without the meeting (what, for whom, which system). Example: "Add the ZHL pre-approval count to Jeff's Monday Slack report".
- due: YYYY-MM-DD if a date or deadline is stated or clearly implied ("by Friday", "before the team meeting"), else null. Resolve relative dates from the meeting date.
- requestedBy: first name of who asked for it, or null if David volunteered it.
- evidence: a short quote or paraphrase from the doc that shows it's David's.
Merge duplicates. Return {"tasks": []} when there's nothing for David.`;

async function extractTasks(doc, text, openTasks) {
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: TASKS_SCHEMA } },
    system: TASKS_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          `Meeting doc: ${doc.name}`,
          `Created: ${doc.createdTime}`,
          `David's open list:\n${openTasks.map((t) => `- ${t.task}`).join("\n") || "(empty)"}`,
          `<doc>\n${text.slice(0, MAX_DOC_CHARS)}\n</doc>`,
        ].join("\n\n"),
      },
    ],
  });
  await logUsage("mytasks", response.model || MODEL, addUsage(emptyUsage(), response.usage), 0);
  const out = JSON.parse(response.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  return (out.tasks || []).filter((t) => t.task && t.task.trim());
}

// ---------- Tasks ----------

async function allTasks() {
  const s = store();
  const { blobs } = await s.list({ prefix: "task/" });
  const tasks = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return tasks.filter(Boolean);
}

// The meeting title without Gemini's " - 2026/11/02 11:00 PST - Notes by Gemini" tail.
const meetingTitle = (name) => String(name).replace(/\s+-\s+\d{4}\/\d{2}\/\d{2}.*$/, "").replace(/\s+-\s+(Notes by Gemini|Transcript)$/, "").trim();

// Analyzes every meeting doc not seen before and saves David's new tasks.
// Returns the number of docs analyzed and tasks added.
async function scanDrive({ log = console.log } = {}) {
  const s = store();
  const token = await googleToken();
  const docs = await meetingDocs(token);
  const seen = new Set((await s.list({ prefix: "file/" })).blobs.map((b) => b.key.slice(5)));
  const fresh = docs.filter((d) => !seen.has(d.id)).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  const open = (await allTasks()).filter((t) => t.status === "open");
  let added = 0;

  // One doc at a time, so each one's tasks are on the open list for the next
  // (the same huddle repeats the same items day after day).
  for (const doc of fresh) {
    let tasks = [];
    try {
      const text = await drive(token, `files/${doc.id}/export`, { mimeType: "text/plain" });
      // Skip the Claude call when David isn't mentioned at all.
      if (/david/i.test(text)) tasks = await extractTasks(doc, text, open);
    } catch (err) {
      log(`My tasks: couldn't analyze "${doc.name}": ${err.message}`);
      continue; // not marked as seen, so tomorrow's run retries it
    }
    for (const t of tasks) {
      const id = crypto.createHash("sha1").update(`${doc.id}|${t.task}`).digest("hex").slice(0, 12);
      const task = {
        id,
        task: t.task.trim(),
        due: /^\d{4}-\d{2}-\d{2}$/.test(t.due || "") ? t.due : null,
        requestedBy: t.requestedBy || null,
        evidence: t.evidence,
        meeting: meetingTitle(doc.name),
        meetingDate: pacificDay(new Date(doc.createdTime)),
        fileId: doc.id,
        link: doc.webViewLink || `https://docs.google.com/document/d/${doc.id}/edit`,
        createdAt: Date.now(),
        status: "open",
      };
      await s.setJSON(`task/${id}`, task);
      open.push(task);
      added += 1;
    }
    await s.setJSON(`file/${doc.id}`, { name: doc.name, analyzedAt: Date.now(), tasks: tasks.length });
    log(`My tasks: "${doc.name}" → ${tasks.length} task(s)`);
  }
  return { docs: fresh.length, added };
}

// ---------- Slack ----------

const shortDate = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const daysBetween = (fromDay, toDay) => Math.round((Date.parse(`${toDay}T12:00:00Z`) - Date.parse(`${fromDay}T12:00:00Z`)) / 864e5);

function taskBlocks(t, today, isNew) {
  const bits = [`<${t.link}|${t.meeting} · ${shortDate(t.meetingDate)}>`];
  if (t.requestedBy) bits.push(`asked by ${t.requestedBy}`);
  if (t.due) bits.push(t.due < today ? `🔴 *was due ${shortDate(t.due)}*` : t.due === today ? "🟠 *due today*" : `due ${shortDate(t.due)}`);
  const age = daysBetween(pacificDay(new Date(t.createdAt)), today);
  if (age > 0) bits.push(`open ${age} day${age === 1 ? "" : "s"}`);
  return [
    { type: "section", block_id: `t_${t.id}`, text: { type: "mrkdwn", text: `${isNew ? "🆕 " : ""}*${t.task}*\n${bits.join(" · ")}` } },
    {
      type: "actions",
      block_id: `a_${t.id}`,
      elements: [
        { type: "button", action_id: "mytask_done", value: t.id, style: "primary", text: { type: "plain_text", text: "✅ Done" } },
        { type: "button", action_id: "mytask_dismiss", value: t.id, text: { type: "plain_text", text: "Not mine" } },
      ],
    },
  ];
}

async function ownerChannel() {
  const user = (await slackGet("users.lookupByEmail", { email: OWNER_EMAIL })).user;
  const dm = await slack("conversations.open", { users: user.id });
  return { userId: user.id, channel: dm.channel.id };
}

// DMs David every open task, overdue first, then by due date, then oldest.
async function sendReminder({ newIds = new Set(), warning } = {}) {
  const today = pacificDay();
  const open = (await allTasks())
    .filter((t) => t.status === "open")
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.createdAt - b.createdAt);
  const { channel } = await ownerChannel();
  const warn = warning ? [{ type: "context", elements: [{ type: "mrkdwn", text: `⚠️ ${warning}` }] }] : [];

  if (!open.length) {
    const text = "🎉 No open tasks from your meetings. I'll check your Drive again tomorrow at 8 AM.";
    await slack("chat.postMessage", { channel, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, ...warn] });
    return 0;
  }
  const fresh = open.filter((t) => newIds.has(t.id)).length;
  const overdue = open.filter((t) => t.due && t.due < today).length;
  const summary = [`${open.length} open`, fresh ? `${fresh} new` : null, overdue ? `${overdue} overdue` : null].filter(Boolean).join(" · ");

  for (let i = 0; i < open.length; i += TASKS_PER_MESSAGE) {
    const chunk = open.slice(i, i + TASKS_PER_MESSAGE);
    const head = i === 0
      ? [{ type: "header", text: { type: "plain_text", text: "📋 Your tasks from meetings" } }, { type: "context", elements: [{ type: "mrkdwn", text: summary }] }, ...warn]
      : [];
    const foot = i + TASKS_PER_MESSAGE >= open.length
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: "Tap ✅ Done when it's finished. I'll remind you every weekday at 8 AM until then." }] }]
      : [];
    await slack("chat.postMessage", {
      channel,
      text: `📋 Your tasks from meetings: ${summary}`,
      blocks: [...head, ...chunk.flatMap((t) => taskBlocks(t, today, newIds.has(t.id))), ...foot],
      unfurl_links: false,
    });
  }
  return open.length;
}

// The weekday-morning run: read new meeting docs, then send the reminder.
// A Drive or Claude failure still sends the reminder, with a warning line.
async function runDaily({ log = console.log } = {}) {
  const before = new Set((await allTasks()).map((t) => t.id));
  let warning;
  try {
    const { docs, added } = await scanDrive({ log });
    log(`My tasks: analyzed ${docs} new doc(s), added ${added} task(s)`);
  } catch (err) {
    log(`My tasks: Drive scan failed: ${err.message}`);
    warning = `Couldn't read your meeting docs today (${String(err.message).slice(0, 150)}). This list may be missing new tasks.`;
  }
  const newIds = new Set((await allTasks()).map((t) => t.id).filter((id) => !before.has(id)));
  await sendReminder({ newIds, warning });
  await store().set(`sent/${pacificDay()}`, String(Date.now()));
}

// ✅ Done / Not mine on a reminder: update the task and cross it out in place.
async function onTaskAction(payload) {
  const action = payload.actions[0];
  const { userId } = await ownerChannel();
  if (payload.user.id !== userId) return;
  const s = store();
  const task = await s.get(`task/${action.value}`, { type: "json" });
  if (!task) return;
  const done = action.action_id === "mytask_done";
  task.status = done ? "done" : "dismissed";
  task.closedAt = Date.now();
  await s.setJSON(`task/${task.id}`, task);

  const blocks = (payload.message.blocks || []).map((b) => {
    if (b.block_id === `t_${task.id}`) return { type: "section", block_id: b.block_id, text: { type: "mrkdwn", text: `~${task.task}~` } };
    if (b.block_id === `a_${task.id}`) {
      return { type: "context", block_id: b.block_id, elements: [{ type: "mrkdwn", text: done ? "✅ Done" : "🚫 Not mine, removed from your list" }] };
    }
    return b;
  });
  await slack("chat.update", { channel: payload.channel.id, ts: payload.message.ts, text: payload.message.text, blocks });
}

module.exports = { runDaily, scanDrive, sendReminder, onTaskAction, store, ownerChannel, OWNER_EMAIL };
