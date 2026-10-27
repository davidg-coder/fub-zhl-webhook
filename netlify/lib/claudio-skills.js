// Claudio's own skills: actions FUB's MCP server can't finish for us (its
// write tools only save through FUB's in-app review widget, which Claudio
// doesn't have). These run on the FUB REST API with the shared FUB_API_KEY,
// so each skill checks the signed-in agent may act on the lead first.
const FUB_BASE = "https://api.followupboss.com/v1";
// "Agent Move to Pond": where agents send leads they're done with. The daily
// pond audit (n8n) reads the "requested to move to pond" note for who moved it.
const AGENT_MOVE_POND_ID = 274;
const MOVE_TAG = "#movetopond";

function fubAuth() {
  return "Basic " + Buffer.from(`${process.env.FUB_API_KEY}:`).toString("base64");
}

async function fub(path, options = {}) {
  const res = await fetch(`${FUB_BASE}${path}`, {
    ...options,
    headers: { Authorization: fubAuth(), "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FUB ${options.method || "GET"} ${path.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

const SKILL_DEFS = [
  {
    name: "move_lead_to_pond",
    description:
      'Move one lead to the "Agent Move to Pond" pond, for when the agent says things like "move this lead to the pond", "throw it to the pond" or "remove this lead". Also tags it #movetopond and logs a note saying who moved it. Call first without confirmed to get a preview, read it back, and only after the agent says yes call again with confirmed=true. Use the person id of the lead on the current page or from a lookup; never guess it.',
    input_schema: {
      type: "object",
      properties: {
        personId: { type: "integer", description: "FUB person id of the lead." },
        reason: { type: "string", description: "Why, in the agent's words, if they gave one." },
        confirmed: { type: "boolean", description: "true only after the agent said yes to the preview." },
      },
      required: ["personId"],
    },
  },
  {
    name: "get_lead_details",
    description:
      "Read one lead's stage, source, assigned agent, tags, price, key dates and most recent notes straight from FUB. Use it for \"what's the latest with…\", \"what stage is…\", \"read me the notes\", and whenever a Follow Up Boss tool for notes or stage is missing or fails.",
    input_schema: {
      type: "object",
      properties: {
        personId: { type: "integer", description: "FUB person id of the lead." },
        notes: { type: "integer", description: "How many recent notes to include (default 5, max 15)." },
      },
      required: ["personId"],
    },
  },
  {
    name: "get_my_call_list",
    description:
      `The signed-in agent's call list straight from FUB: leads with tasks due today or overdue first, then new leads never contacted, then the leads they haven't touched the longest. Each has stage, phone and why they're on the list. Use it for "who should I call today", "who needs follow-up", and call lists of the agent's own leads by stage or tag, and whenever a Follow Up Boss tool for follow-ups fails.`,
    input_schema: {
      type: "object",
      properties: {
        stage: { type: "string", description: "Only leads in this FUB stage, e.g. \"Hot\" or \"Met with customer\"." },
        tag: { type: "string", description: "Only leads with this tag." },
        limit: { type: "integer", description: "How many leads (default 10, max 25)." },
      },
    },
  },
  {
    name: "get_pond_call_list",
    description:
      `A call list from a lead pond the signed-in agent belongs to, e.g. "go through my pond and find leads in Whittier under 700k for my open house, ranked by most activity". Filters by city, price, stage and tag; ranks the most recently active first (or the stalest first). Returns at most 25 leads; it never exports a pond.`,
    input_schema: {
      type: "object",
      properties: {
        pond: { type: "string", description: "Pond name, or part of it. Leave out to use the agent's only pond." },
        city: { type: "string", description: "Only leads with an address in this city." },
        priceBelow: { type: "integer" },
        priceAbove: { type: "integer" },
        stage: { type: "string" },
        tag: { type: "string" },
        activeWithinDays: { type: "integer", description: "Only leads with activity in the last N days, e.g. 365 for the last 12 months." },
        sort: { type: "string", enum: ["most_active", "stalest"], description: "Default most_active." },
        limit: { type: "integer", description: "How many leads (default 15, max 25)." },
      },
    },
  },
];

const SKILL_NAMES = new Set(SKILL_DEFS.map((d) => d.name));

async function moveLeadToPond(input, user) {
  if (!user || !user.id) return { text: "Can't tell who is signed in, so I can't move leads right now.", isError: true };
  const personId = Number(input.personId);
  if (!Number.isInteger(personId) || personId <= 0) return { text: "A valid personId is required.", isError: true };

  const person = await fub(`/people/${personId}`);
  const name = person.name || `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`;
  const isBroker = /broker|admin|owner/i.test(user.role || "");
  if (!isBroker && person.assignedUserId !== user.id) {
    return {
      text: `${name} is assigned to ${person.assignedTo || "someone else"}, not ${user.name}. Agents can only move their own leads to the pond.`,
      isError: true,
    };
  }
  if (person.assignedPondId === AGENT_MOVE_POND_ID) {
    return { text: `${name} is already in the Agent Move to Pond pond. Nothing to do.`, isError: false };
  }
  if (!input.confirmed) {
    return {
      text: JSON.stringify({
        preview: true,
        person: { id: personId, name, stage: person.stage, assignedTo: person.assignedTo },
        action: `Move ${name} to the "Agent Move to Pond" pond, tag ${MOVE_TAG} and log a note.`,
        next: "Ask the agent to confirm, then call move_lead_to_pond again with confirmed=true.",
      }),
      isError: false,
    };
  }

  await fub(`/people/${personId}?mergeTags=true`, {
    method: "PUT",
    body: JSON.stringify({ assignedPondId: AGENT_MOVE_POND_ID, tags: [MOVE_TAG] }),
  });
  const reason = typeof input.reason === "string" && input.reason.trim() ? ` Reason: ${input.reason.trim().slice(0, 500)}` : "";
  await fub("/notes", {
    method: "POST",
    body: JSON.stringify({
      personId,
      subject: "Moved to pond via Claudio",
      body: `${user.name} requested to move to pond (via Claudio).${reason}`,
    }),
  });
  console.log(`Claudio skill move_lead_to_pond person=${personId} by user=${user.id}`);
  return {
    text: JSON.stringify({ done: true, person: { id: personId, name }, pond: "Agent Move to Pond", tagAdded: MOVE_TAG, noteLogged: true }),
    isError: false,
  };
}

// Reads go through the shared API key, so they get the same ownership check
// as writes: agents only see their own leads here.
async function getLeadDetails(input, user) {
  if (!user || !user.id) return { text: "Can't tell who is signed in, so I can't read leads right now.", isError: true };
  const personId = Number(input.personId);
  if (!Number.isInteger(personId) || personId <= 0) return { text: "A valid personId is required.", isError: true };

  const person = await fub(`/people/${personId}`);
  const name = person.name || `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`;
  const isBroker = /broker|admin|owner/i.test(user.role || "");
  if (!isBroker && person.assignedUserId !== user.id) {
    return { text: `${name} is assigned to ${person.assignedTo || "someone else"}, so I can't read their details for ${user.name}.`, isError: true };
  }

  const limit = Math.min(Math.max(Number(input.notes) || 5, 1), 15);
  let notes = [];
  try {
    const data = await fub(`/notes?personId=${personId}&limit=${limit}&sort=-created`);
    notes = (data.notes || []).map((n) => ({
      created: n.created,
      by: n.createdBy,
      subject: n.subject || undefined,
      body: String(n.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600),
    }));
  } catch (err) {
    console.error("Claudio skill get_lead_details notes failed:", err.message);
  }
  return {
    text: JSON.stringify({
      person: {
        id: personId,
        name,
        stage: person.stage,
        source: person.source,
        assignedTo: person.assignedTo,
        pond: person.assignedPondId ? `pond ${person.assignedPondId}` : undefined,
        tags: person.tags,
        price: person.price || undefined,
        created: person.created,
        lastActivity: person.lastActivity,
        phones: (person.phones || []).map((p) => p.value),
      },
      notes,
    }),
    isError: false,
  };
}

// Leads that aren't worth calling from a call list.
const SKIP_STAGES = /closed|trash|past client|archive|recruit|do not contact/i;

function endOfTodayPacific() {
  const now = new Date();
  const date = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const tz = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName").value;
  return new Date(`${date}T23:59:59${tz.replace("GMT", "") || "+00:00"}`).toISOString();
}

const phoneOf = (p) => ((p.phones || []).find((x) => x.isPrimary) || (p.phones || [])[0] || {}).value || null;

async function getMyCallList(input, user) {
  if (!user || !user.id) return { text: "Can't tell who is signed in, so I can't build a call list right now.", isError: true };
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 25);
  const filters = `${input.stage ? `&stage=${encodeURIComponent(input.stage)}` : ""}${input.tag ? `&tags=${encodeURIComponent(input.tag)}` : ""}`;
  const fields = "id,name,firstName,lastName,stage,phones,lastActivity,created,contacted,assignedPondId,assignedUserId";

  const [tasksRes, peopleRes] = await Promise.all([
    filters
      ? Promise.resolve({ tasks: [] })
      : fub(`/tasks?assignedUserId=${user.id}&isCompleted=false&dueEnd=${encodeURIComponent(endOfTodayPacific())}&limit=100`).catch((err) => {
          console.error("Claudio skill get_my_call_list tasks failed:", err.message);
          return { tasks: [] };
        }),
    fub(`/people?assignedUserId=${user.id}&sort=lastActivity&limit=100&fields=${fields}${filters}`),
  ]);

  const usable = (p) => p && !p.assignedPondId && p.assignedUserId === user.id && !SKIP_STAGES.test(p.stage || "");
  const people = (peopleRes.people || []).filter(usable);
  const byId = new Map(people.map((p) => [p.id, p]));

  // Earliest open task per lead.
  const dueBy = new Map();
  for (const t of tasksRes.tasks || []) {
    if (!t.personId || t.isCompleted) continue;
    const due = t.dueDateTime || t.dueDate;
    if (!dueBy.has(t.personId) || String(due) < String(dueBy.get(t.personId).due)) dueBy.set(t.personId, { due, task: t.name || t.type });
  }
  const missing = [...dueBy.keys()].filter((id) => !byId.has(id)).slice(0, limit);
  const extra = await Promise.all(missing.map((id) => fub(`/people/${id}`).catch(() => null)));
  for (const p of extra) if (usable(p)) byId.set(p.id, p);

  const out = [];
  const add = (p, why) => {
    if (out.length < limit && !out.some((o) => o.id === p.id)) {
      const name = p.name || `${p.firstName || ""} ${p.lastName || ""}`.trim() || `Lead #${p.id}`;
      out.push({ id: p.id, name, stage: p.stage, phone: phoneOf(p), lastActivity: p.lastActivity, why });
    }
  };
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  [...dueBy.entries()]
    .sort((a, b) => String(a[1].due).localeCompare(String(b[1].due)))
    .forEach(([id, t]) => byId.has(id) && add(byId.get(id), `${String(t.due).slice(0, 10) < today ? "overdue" : "due today"} task: ${t.task}`));
  people
    .filter((p) => p.contacted === 0 || p.contacted === false)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .forEach((p) => add(p, "new lead, never contacted"));
  people.forEach((p) => add(p, "longest since last activity"));

  console.log(`Claudio skill get_my_call_list user=${user.id} tasks=${dueBy.size} people=${people.length} out=${out.length}`);
  return {
    text: JSON.stringify({ agent: user.name, totalOpenLeadsChecked: people.length, leadsWithTasksDue: dueBy.size, callList: out }),
    isError: false,
  };
}

// Pond lists go through the shared key, so the agent must be a member of the
// pond. Results are capped like every other list (no exports).
async function getPondCallList(input, user) {
  if (!user || !user.id) return { text: "Can't tell who is signed in, so I can't read ponds right now.", isError: true };
  const isBroker = /broker|admin|owner/i.test(user.role || "");
  const ponds = (await fub("/ponds?limit=100")).ponds || [];
  const mine = ponds.filter((p) => isBroker || p.userId === user.id || (p.userIds || []).includes(user.id));
  const want = String(input.pond || "").trim().toLowerCase();
  const matches = want ? mine.filter((p) => String(p.name).toLowerCase().includes(want)) : mine;
  if (matches.length !== 1) {
    return {
      text: JSON.stringify({
        error: matches.length ? "More than one pond matches; ask which one." : `No pond${want ? ` matching "${input.pond}"` : ""} that ${user.name} belongs to.`,
        pondsYouBelongTo: mine.map((p) => p.name),
      }),
      isError: !matches.length,
    };
  }
  const pond = matches[0];
  const limit = Math.min(Math.max(Number(input.limit) || 15, 1), 25);
  const q = [
    `assignedPondId=${pond.id}`,
    `sort=${input.sort === "stalest" ? "lastActivity" : "-lastActivity"}`,
    "limit=100",
    "fields=id,name,firstName,lastName,stage,phones,addresses,price,lastActivity,tags",
    input.priceBelow ? `priceBelow=${Number(input.priceBelow)}` : "",
    input.priceAbove ? `priceAbove=${Number(input.priceAbove)}` : "",
    input.stage ? `stage=${encodeURIComponent(input.stage)}` : "",
    input.tag ? `tags=${encodeURIComponent(input.tag)}` : "",
    input.activeWithinDays ? `lastActivityAfter=${encodeURIComponent(new Date(Date.now() - Number(input.activeWithinDays) * 864e5).toISOString())}` : "",
  ].filter(Boolean).join("&");
  const city = String(input.city || "").trim().toLowerCase();
  const out = [];
  let checked = 0;
  // Cursor paging (deep offsets are disabled); stop once the list is full.
  for (let url = `/people?${q}`, page = 0; url && page < 10 && out.length < limit; page++) {
    const data = await fub(url);
    for (const p of data.people || []) {
      checked++;
      if (SKIP_STAGES.test(p.stage || "")) continue;
      if (city && !(p.addresses || []).some((a) => String(a.city || "").trim().toLowerCase() === city)) continue;
      if (out.length >= limit) break;
      const name = p.name || `${p.firstName || ""} ${p.lastName || ""}`.trim() || `Lead #${p.id}`;
      const addr = (p.addresses || [])[0];
      out.push({ id: p.id, name, stage: p.stage, phone: phoneOf(p), city: addr && addr.city, price: p.price || undefined, lastActivity: p.lastActivity });
    }
    const next = data._metadata && data._metadata.nextLink;
    url = next ? next.replace(/^https:\/\/api\.followupboss\.com\/v1/, "") : null;
  }
  console.log(`Claudio skill get_pond_call_list user=${user.id} pond=${pond.id} checked=${checked} out=${out.length}`);
  return { text: JSON.stringify({ pond: pond.name, leadsChecked: checked, callList: out }), isError: false };
}

async function runSkill(name, input, user) {
  if (!process.env.FUB_API_KEY) return { text: "FUB_API_KEY is not set on Netlify.", isError: true };
  if (name === "move_lead_to_pond") return moveLeadToPond(input || {}, user);
  if (name === "get_lead_details") return getLeadDetails(input || {}, user);
  if (name === "get_my_call_list") return getMyCallList(input || {}, user);
  if (name === "get_pond_call_list") return getPondCallList(input || {}, user);
  return { text: `Unknown skill ${name}.`, isError: true };
}

module.exports = { SKILL_DEFS, SKILL_NAMES, runSkill, fub, getMyCallList, endOfTodayPacific };
