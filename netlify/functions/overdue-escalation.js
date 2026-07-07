// Runs hourly. FUB has no "task became overdue" webhook, so this polls for
// incomplete tasks whose due date is 48h+ in the past and pings Slack the
// first time each task crosses that line. The account has a large existing
// backlog of stale tasks (created before this went live), so this only ever
// looks at tasks created after `since` (set once, on first run) — the
// backlog is permanently excluded, not just skipped on day one. A Netlify
// Blobs store of already-alerted task IDs keeps it from repeating.
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

async function fetchOverdueTasks(cutoff, since) {
  const tasks = [];
  let next = null;
  do {
    const url = new URL(`${FUB_BASE}/tasks`);
    url.searchParams.set("isCompleted", "false");
    url.searchParams.set("dueDateBefore", iso(cutoff));
    url.searchParams.set("createdAfter", since);
    url.searchParams.set("limit", "100");
    if (next) url.searchParams.set("next", next);
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) throw new Error(`FUB tasks ${res.status}`);
    const data = await res.json();
    tasks.push(...(data.tasks || []));
    next = data._metadata && data._metadata.next;
  } while (next && tasks.length < 1000);
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

  const cutoff = new Date(Date.now() - OVERDUE_HOURS * 3600 * 1000);
  const tasks = await fetchOverdueTasks(cutoff, since);

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

  return { statusCode: 200, body: `checked ${tasks.length}, alerted ${newlyOverdue.length}` };
};

exports.handler = schedule("0 * * * *", handler);
