// Runs hourly. FUB has no "task became overdue" webhook, so this polls for
// incomplete tasks whose due date is 48h+ in the past and pings Slack the
// first time each task crosses that line. The account has a large existing
// backlog of stale tasks (created before this went live), so this only ever
// looks at tasks created after `since` (set once, on first run) — the
// backlog is permanently excluded, not just skipped on day one. A Netlify
// Blobs store of already-alerted task IDs keeps it from repeating.
//
// FUB's `dueDateBefore` query param is silently ignored by the /tasks API
// (confirmed live: passing a 2020 cutoff still returns tasks due in 2026), so
// due-date filtering is done locally against each task's own dueDate/
// dueDateTime instead of trusting the API to pre-filter.
const { schedule } = require("@netlify/functions");
const { getStore } = require("@netlify/blobs");

const OVERDUE_HOURS = 48;
const FUB_BASE = "https://api.followupboss.com/v1";

function authHeader() {
  return "Basic " + Buffer.from(`${process.env.FUB_API_KEY}:`).toString("base64");
}

function iso(d) {
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

// FUB stores plain tasks as a date-only `dueDate` (no time) in the account's
// local time. Treat that as end-of-day Pacific; use `dueDateTime` instead
// when the task has a specific time.
function pacificOffsetHours(date) {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "shortOffset",
  })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName").value; // e.g. "GMT-7"
  const match = part.match(/GMT([+-]\d+)/);
  return match ? parseInt(match[1], 10) : -8;
}

function dueTimestamp(task) {
  if (task.dueDateTime) return new Date(task.dueDateTime).getTime();
  if (!task.dueDate) return null;
  const offset = pacificOffsetHours(new Date(`${task.dueDate}T12:00:00Z`));
  const sign = offset >= 0 ? "+" : "-";
  const offsetStr = `${sign}${String(Math.abs(offset)).padStart(2, "0")}:00`;
  return new Date(`${task.dueDate}T23:59:59${offsetStr}`).getTime();
}

async function fetchIncompleteTasks(since) {
  const tasks = [];
  let next = null;
  do {
    const url = new URL(`${FUB_BASE}/tasks`);
    url.searchParams.set("isCompleted", "false");
    url.searchParams.set("createdAfter", since);
    url.searchParams.set("limit", "100");
    if (next) url.searchParams.set("next", next);
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) throw new Error(`FUB tasks ${res.status}`);
    const data = await res.json();
    tasks.push(...(data.tasks || []));
    next = data._metadata && data._metadata.next;
  } while (next && tasks.length < 5000);
  return tasks;
}

const handler = async () => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl || !process.env.FUB_API_KEY) {
    return { statusCode: 500, body: "SLACK_WEBHOOK_URL or FUB_API_KEY not configured" };
  }

  const store = getStore({
    name: "overdue-task-alerts",
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });

  let since = await store.get("since", { type: "text" });
  if (!since) {
    since = iso(new Date());
    await store.setJSON("ids", []);
    await store.set("since", since);
    return { statusCode: 200, body: `initialized — only watching tasks created after ${since}` };
  }

  const cutoff = Date.now() - OVERDUE_HOURS * 3600 * 1000;
  const allTasks = await fetchIncompleteTasks(since);
  const tasks = allTasks.filter((t) => {
    const due = dueTimestamp(t);
    return due !== null && due <= cutoff;
  });

  const alerted = new Set((await store.get("ids", { type: "json" })) || []);
  const newlyOverdue = tasks.filter((t) => !alerted.has(t.id));

  for (const task of newlyOverdue) {
    const agent = task.AssignedTo || "Unassigned";
    const text =
      `🔴 *Task escalation:* "${task.name}" for lead #${task.personId}, ` +
      `assigned to *${agent}*, is now ${OVERDUE_HOURS}h+ overdue (due ${task.dueDate}) — ` +
      `<https://power.followupboss.com/2/people/view/${task.personId}|Open in FUB>`;
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => {});
    alerted.add(task.id);
  }

  if (newlyOverdue.length > 0) {
    await store.setJSON("ids", [...alerted]);
  }

  return {
    statusCode: 200,
    body: `checked ${allTasks.length} incomplete, ${tasks.length} actually overdue, alerted ${newlyOverdue.length}`,
  };
};

exports.handler = schedule("0 * * * *", handler);
