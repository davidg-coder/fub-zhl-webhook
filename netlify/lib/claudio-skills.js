// Claudio's own skills: actions FUB's MCP server can't finish for us (its
// write tools only save through FUB's in-app review widget, which Claudio
// doesn't have). These run on the FUB REST API with the shared FUB_API_KEY,
// so each skill checks the signed-in agent may act on the lead first.
const FUB_BASE = "https://api.followupboss.com/v1";
// "Agent Move to Pond": where agents send leads they're done with. The daily
// pond audit (n8n) reads the "requested to move to pond" note for who moved it.
const AGENT_MOVE_POND_ID = 274;
const MOVE_TAG = "#movetopond";
// Leads who asked not to be contacted: DNC tag + the "DNC" pond.
const DNC_POND_ID = 209;
const DNC_TAG = "DNC";
// Recruiting leads (agents we tried to recruit) who aren't a fit for the team.
const NOT_A_FIT_POND_ID = 292;

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
  {
    name: "get_my_numbers",
    description:
      `The signed-in agent's own numbers straight from FUB: open leads per stage (their pipeline), new leads assigned, appointments and calls over the last N days. Use it for "how am I doing", "how many appointments did I have this month", "what does my pipeline look like", and to compare against their business-plan goals. Admins may pass agentName to see another agent.`,
    input_schema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "Look-back window for new leads, appointments and calls (default 30, max 365)." },
        agentName: { type: "string", description: "Admins only: another agent's FUB name." },
      },
    },
  },
  {
    name: "mark_dnc",
    description:
      'Mark one lead Do Not Contact: tags it DNC, moves it to the "DNC" pond and logs a note saying who did it. Use it for "DNC", "do not call", "mark as do not contact", "they asked to be removed from our lists", never a plain tag change. Call first without confirmed to get a preview, read it back, and only after the agent says yes call again with confirmed=true. Use the person id of the lead on the current page or from a lookup; never guess it.',
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
    name: "move_to_recruiting_not_a_fit",
    description:
      'Move one recruiting lead (an agent we are recruiting, not a buyer or seller) to the "Recruiting - Not a Fit" pond and log a note saying who did it. Use it for "not a fit", "move to not a fit", "this recruit is not a fit". For buyer/seller leads use move_lead_to_pond instead. Call first without confirmed to get a preview, read it back, and only after the agent says yes call again with confirmed=true. Use the person id of the lead on the current page or from a lookup; never guess it.',
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
    name: "add_collaborator",
    description:
      'Add another FUB user as a collaborator on one lead, for "add <name> as collaborator", "share this lead with <name>", "let <name> work this lead too". It never changes who the lead is assigned to. Call first without confirmed to get a preview (it resolves the user name), read it back, and only after the agent says yes call again with confirmed=true. Use the person id of the lead on the current page or from a lookup; never guess it.',
    input_schema: {
      type: "object",
      properties: {
        personId: { type: "integer", description: "FUB person id of the lead." },
        collaboratorName: { type: "string", description: "Name of the FUB user to add, as the agent said it." },
        confirmed: { type: "boolean", description: "true only after the agent said yes to the preview." },
      },
      required: ["personId", "collaboratorName"],
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

async function markDnc(input, user) {
  if (!user || !user.id) return { text: "Can't tell who is signed in, so I can't mark leads DNC right now.", isError: true };
  const personId = Number(input.personId);
  if (!Number.isInteger(personId) || personId <= 0) return { text: "A valid personId is required.", isError: true };

  const person = await fub(`/people/${personId}`);
  const name = person.name || `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`;
  const isBroker = /broker|admin|owner/i.test(user.role || "");
  if (!isBroker && person.assignedUserId !== user.id) {
    return {
      text: `${name} is assigned to ${person.assignedTo || "someone else"}, not ${user.name}. Agents can only mark their own leads DNC.`,
      isError: true,
    };
  }
  const hasTag = (person.tags || []).some((t) => String(t).toLowerCase() === DNC_TAG.toLowerCase());
  if (hasTag && person.assignedPondId === DNC_POND_ID) {
    return { text: `${name} is already tagged ${DNC_TAG} and in the DNC pond. Nothing to do.`, isError: false };
  }
  if (!input.confirmed) {
    return {
      text: JSON.stringify({
        preview: true,
        person: { id: personId, name, stage: person.stage, assignedTo: person.assignedTo, alreadyTagged: hasTag },
        action: `${hasTag ? "" : `Tag ${name} ${DNC_TAG}, `}move ${name} to the "DNC" pond and log a note.`,
        next: "Ask the agent to confirm, then call mark_dnc again with confirmed=true.",
      }),
      isError: false,
    };
  }

  await fub(`/people/${personId}?mergeTags=true`, {
    method: "PUT",
    body: JSON.stringify({ assignedPondId: DNC_POND_ID, tags: [DNC_TAG] }),
  });
  const reason = typeof input.reason === "string" && input.reason.trim() ? ` Reason: ${input.reason.trim().slice(0, 500)}` : "";
  await fub("/notes", {
    method: "POST",
    body: JSON.stringify({ personId, subject: "Marked DNC via Claudio", body: `${user.name} marked this lead Do Not Contact and moved it to the DNC pond (via Claudio).${reason}` }),
  });
  console.log(`Claudio skill mark_dnc person=${personId} by user=${user.id}`);
  return {
    text: JSON.stringify({ done: true, person: { id: personId, name }, pond: "DNC", tag: DNC_TAG, noteLogged: true }),
    isError: false,
  };
}

async function moveToRecruitingNotAFit(input, user) {
  if (!user || !user.id) return { text: "Can't tell who is signed in, so I can't move leads right now.", isError: true };
  const personId = Number(input.personId);
  if (!Number.isInteger(personId) || personId <= 0) return { text: "A valid personId is required.", isError: true };

  const person = await fub(`/people/${personId}`);
  const name = person.name || `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`;
  if (person.assignedPondId === NOT_A_FIT_POND_ID) {
    return { text: `${name} is already in the Recruiting - Not a Fit pond. Nothing to do.`, isError: false };
  }
  // Recruiting leads often sit in a recruiting pond, so members of the lead's
  // current pond may move it too, not just the assigned agent.
  const isBroker = /broker|admin|owner/i.test(user.role || "");
  let inPond = false;
  if (!isBroker && person.assignedUserId !== user.id && person.assignedPondId) {
    const pond = await fub(`/ponds/${person.assignedPondId}`).catch(() => null);
    inPond = !!pond && (pond.userId === user.id || (pond.userIds || []).includes(user.id));
  }
  if (!isBroker && person.assignedUserId !== user.id && !inPond) {
    return {
      text: `${name} is assigned to ${person.assignedTo || "someone else"}, not ${user.name}. You can only move leads assigned to you or sitting in a pond you belong to.`,
      isError: true,
    };
  }
  if (!input.confirmed) {
    return {
      text: JSON.stringify({
        preview: true,
        person: { id: personId, name, stage: person.stage, assignedTo: person.assignedTo, currentPondId: person.assignedPondId || null },
        action: `Move ${name} to the "Recruiting - Not a Fit" pond and log a note.`,
        next: "Ask the agent to confirm, then call move_to_recruiting_not_a_fit again with confirmed=true.",
      }),
      isError: false,
    };
  }

  await fub(`/people/${personId}`, { method: "PUT", body: JSON.stringify({ assignedPondId: NOT_A_FIT_POND_ID }) });
  const reason = typeof input.reason === "string" && input.reason.trim() ? ` Reason: ${input.reason.trim().slice(0, 500)}` : "";
  await fub("/notes", {
    method: "POST",
    body: JSON.stringify({ personId, subject: "Moved to Recruiting - Not a Fit via Claudio", body: `${user.name} moved this lead to the Recruiting - Not a Fit pond (via Claudio).${reason}` }),
  });
  console.log(`Claudio skill move_to_recruiting_not_a_fit person=${personId} by user=${user.id}`);
  return { text: JSON.stringify({ done: true, person: { id: personId, name }, pond: "Recruiting - Not a Fit", noteLogged: true }), isError: false };
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

// Pipeline stages counted for get_my_numbers, in funnel order.
const PIPELINE_STAGES = [
  "Lead", "Attempted Contact", "Spoke with Customer", "Appointment Set", "Met with customer",
  "Showing Homes", "Submitting Offers", "Listing agreement", "Under Contract", "Active Listing", "Nurture", "Closed",
];

// Follows the cursor (deep offsets are disabled) through a list sorted newest
// first, stopping once rows are older than `since` or after 10 pages.
async function countSince(path, key, since, keep) {
  let n = 0;
  let capped = false;
  for (let url = path, page = 0; url; page++) {
    if (page >= 10) {
      capped = true;
      break;
    }
    const data = await fub(url);
    const rows = data[key] || [];
    let older = false;
    for (const r of rows) {
      if (String(r.created) < since) older = true;
      else if (keep(r)) n++;
    }
    const next = data._metadata && data._metadata.nextLink;
    url = !older && next ? next.replace(/^https:\/\/api\.followupboss\.com\/v1/, "") : null;
  }
  return { n, capped };
}

// FUB /calls has no userId filter (the team logs ~3,700 calls a day), so an
// agent's calls are counted by their FUB calling numbers instead. The numbers
// are learned from the calls on their most recently active leads.
async function agentCallNumbers(agentId) {
  const people = (await fub(`/people?assignedUserId=${agentId}&sort=-lastActivity&limit=10&fields=id,assignedPondId`)).people || [];
  const numbers = new Set();
  for (const p of people.filter((x) => !x.assignedPondId).slice(0, 8)) {
    const calls = (await fub(`/calls?personId=${p.id}&limit=25`)).calls || [];
    for (const c of calls) {
      if (c.userId !== agentId) continue;
      const n = String((c.isIncoming ? c.toNumber : c.fromNumber) || "").replace(/\D/g, "").slice(-10);
      if (n.length === 10) numbers.add(n);
    }
    if (numbers.size >= 3) break;
  }
  return [...numbers];
}

// Calls on one number since `since`. Trusts FUB's total when the first page is
// all this agent's; otherwise counts page by page (shared number).
async function callsOnNumber(param, number, agentId, since) {
  const data = await fub(`/calls?${param}=${number}&createdAfter=${encodeURIComponent(since)}&limit=100`);
  const rows = data.calls || [];
  const total = (data._metadata && data._metadata.total) || rows.length;
  if (rows.every((c) => c.userId === agentId)) return { n: total, capped: false };
  return countSince(`/calls?${param}=${number}&createdAfter=${encodeURIComponent(since)}&limit=100`, "calls", since, (c) => c.userId === agentId);
}

async function countCalls(agentId, since) {
  const numbers = await agentCallNumbers(agentId);
  if (!numbers.length) return { outgoing: 0, incoming: 0, capped: false, numbersFound: 0 };
  let outgoing = 0, incoming = 0, capped = false;
  for (const n of numbers) {
    const [o, i] = await Promise.all([callsOnNumber("fromNumber", n, agentId, since), callsOnNumber("toNumber", n, agentId, since)]);
    outgoing += o.n;
    incoming += i.n;
    capped = capped || o.capped || i.capped;
  }
  return { outgoing, incoming, capped, numbersFound: numbers.length };
}

async function getMyNumbers(input, user) {
  if (!user || !user.id) return { text: "Can't tell who is signed in, so I can't read numbers right now.", isError: true };
  const isAdmin = /broker|admin|owner/i.test(user.role || "") || user.portalRole === "admin";
  let agent = { id: user.id, name: user.name };
  if (input.agentName && String(input.agentName).trim().toLowerCase() !== String(user.name || "").toLowerCase()) {
    if (!isAdmin) return { text: "Other agents' numbers are for admins only.", isError: true };
    const found = findUser(await allUsers(), input.agentName);
    if (found.length !== 1) return { text: JSON.stringify({ error: found.length ? "More than one user matches; ask which one." : `No FUB user matching "${input.agentName}".`, matches: found.map((u) => u.name) }), isError: !found.length };
    agent = { id: found[0].id, name: found[0].name };
  }
  const days = Math.min(Math.max(Number(input.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const now = new Date().toISOString();

  // Leads sitting in a pond keep the pond owner as assignedUserId, so a pond
  // owner's per-stage totals subtract the leads in the ponds they own.
  const ownedPonds = ((await fub("/ponds?limit=100").catch(() => ({}))).ponds || []).filter((p) => p.userId === agent.id);
  const totalOf = (q) => fub(`/people?limit=1&fields=id${q}`).then((d) => (d._metadata && d._metadata.total) || 0);
  const stageCount = async (st) => {
    const stage = `&stage=${encodeURIComponent(st)}`;
    const [all, ...inPonds] = await Promise.all([
      totalOf(`&assignedUserId=${agent.id}${stage}`),
      ...ownedPonds.map((p) => totalOf(`&assignedPondId=${p.id}${stage}`)),
    ]);
    return Math.max(all - inPonds.reduce((a, b) => a + b, 0), 0);
  };
  const [pipeline, newLeads, appts, calls] = await Promise.all([
    Promise.all(PIPELINE_STAGES.map((st) => stageCount(st).catch(() => null))),
    countSince(`/people?assignedUserId=${agent.id}&sort=-created&limit=100&fields=id,created,assignedUserId,assignedPondId`, "people", since, (p) => p.assignedUserId === agent.id && !p.assignedPondId).catch(() => null),
    fub(`/appointments?userId=${agent.id}&start=${encodeURIComponent(since)}&end=${encodeURIComponent(now)}&limit=100`)
      .then((d) => (d.appointments || []).filter((a) => (a.invitees || []).some((i) => i.userId === agent.id)))
      .catch(() => null),
    countCalls(agent.id, since).catch(() => null),
  ]);
  const plus = (n) => (calls && calls.capped ? `${n}+` : n);
  const out = {
    agent: agent.name,
    windowDays: days,
    pipelineByStage: Object.fromEntries(PIPELINE_STAGES.map((st, i) => [st, pipeline[i]]).filter(([, n]) => n)),
    newLeadsAssigned: newLeads && (newLeads.capped ? `${newLeads.n}+` : newLeads.n),
    appointments: appts && {
      total: appts.length,
      byType: appts.reduce((m, a) => ({ ...m, [a.type || a.title || "Other"]: (m[a.type || a.title || "Other"] || 0) + 1 }), {}),
    },
    calls: calls && {
      outgoing: plus(calls.outgoing),
      incoming: plus(calls.incoming),
      note: calls.numbersFound ? "Calls made or received on the agent's FUB calling number(s); calls logged by hand aren't included." : "No FUB calling number found on the agent's recent leads, so calls can't be counted.",
    },
  };
  console.log(`Claudio skill get_my_numbers user=${user.id} agent=${agent.id} days=${days} ponds=${ownedPonds.length} callNumbers=${calls && calls.numbersFound}`);
  return { text: JSON.stringify(out), isError: false };
}

// /users is capped at 100 per page and the team has more, so follow nextLink.
async function allUsers() {
  const users = [];
  let path = "/users?limit=100&fields=id,name,role,status";
  for (let i = 0; path && i < 10; i++) {
    const data = await fub(path);
    users.push(...(data.users || []));
    const next = data._metadata && data._metadata.nextLink;
    path = next ? next.replace(FUB_BASE, "") : null;
  }
  return users;
}

function findUser(users, name) {
  const want = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!want) return [];
  const exact = users.filter((u) => String(u.name).toLowerCase() === want);
  if (exact.length) return exact;
  const words = want.split(" ");
  return users.filter((u) => words.every((w) => String(u.name).toLowerCase().includes(w)));
}

async function addCollaborator(input, user) {
  if (!user || !user.id) return { text: "Can't tell who is signed in, so I can't change collaborators right now.", isError: true };
  const personId = Number(input.personId);
  if (!Number.isInteger(personId) || personId <= 0) return { text: "A valid personId is required.", isError: true };

  const person = await fub(`/people/${personId}?fields=id,name,firstName,lastName,assignedTo,assignedUserId,collaborators`);
  const name = person.name || `${person.firstName || ""} ${person.lastName || ""}`.trim() || `Lead #${personId}`;
  const isBroker = /broker|admin|owner/i.test(user.role || "");
  if (!isBroker && person.assignedUserId !== user.id) {
    return {
      text: `${name} is assigned to ${person.assignedTo || "someone else"}, not ${user.name}. Agents can only add collaborators to their own leads.`,
      isError: true,
    };
  }

  const found = findUser((await allUsers()).filter((u) => !/inactive|deleted/i.test(u.status || "")), input.collaboratorName);
  if (found.length !== 1) {
    return {
      text: JSON.stringify({
        error: found.length ? "More than one user matches; ask which one." : `No active FUB user matching "${input.collaboratorName}".`,
        matches: found.slice(0, 10).map((u) => u.name),
      }),
      isError: !found.length,
    };
  }
  const collab = found[0];
  const current = person.collaborators || [];
  if (current.some((c) => c.id === collab.id)) {
    return { text: `${collab.name} is already on ${name}. Nothing to do.`, isError: false };
  }
  if (!input.confirmed) {
    return {
      text: JSON.stringify({
        preview: true,
        person: { id: personId, name, assignedTo: person.assignedTo, collaborators: current.map((c) => c.name) },
        action: `Add ${collab.name} as a collaborator on ${name}. ${person.assignedTo || "The assigned agent"} stays the assigned agent.`,
        next: "Ask the agent to confirm, then call add_collaborator again with confirmed=true.",
      }),
      isError: false,
    };
  }

  // PUT replaces the whole list, so send the existing collaborators too.
  const ids = [...current.map((c) => c.id), collab.id];
  try {
    await fub(`/people/${personId}`, { method: "PUT", body: JSON.stringify({ collaborators: ids }) });
  } catch (err) {
    console.error("Claudio skill add_collaborator id list rejected, retrying as objects:", err.message);
    await fub(`/people/${personId}`, { method: "PUT", body: JSON.stringify({ collaborators: ids.map((id) => ({ id })) }) });
  }
  const after = await fub(`/people/${personId}?fields=id,collaborators`);
  const names = (after.collaborators || []).map((c) => c.name);
  if (!(after.collaborators || []).some((c) => c.id === collab.id)) {
    return { text: `FUB accepted the change but ${collab.name} isn't showing as a collaborator on ${name}. Add them from the contact profile.`, isError: true };
  }
  await fub("/notes", {
    method: "POST",
    body: JSON.stringify({ personId, subject: "Collaborator added via Claudio", body: `${user.name} added ${collab.name} as a collaborator (via Claudio).` }),
  }).catch((err) => console.error("Claudio skill add_collaborator note failed:", err.message));
  console.log(`Claudio skill add_collaborator person=${personId} collaborator=${collab.id} by user=${user.id}`);
  return { text: JSON.stringify({ done: true, person: { id: personId, name }, added: collab.name, collaborators: names }), isError: false };
}

async function runSkill(name, input, user) {
  if (!process.env.FUB_API_KEY) return { text: "FUB_API_KEY is not set on Netlify.", isError: true };
  if (name === "move_lead_to_pond") return moveLeadToPond(input || {}, user);
  if (name === "get_lead_details") return getLeadDetails(input || {}, user);
  if (name === "get_my_call_list") return getMyCallList(input || {}, user);
  if (name === "get_pond_call_list") return getPondCallList(input || {}, user);
  if (name === "get_my_numbers") return getMyNumbers(input || {}, user);
  if (name === "mark_dnc") return markDnc(input || {}, user);
  if (name === "move_to_recruiting_not_a_fit") return moveToRecruitingNotAFit(input || {}, user);
  if (name === "add_collaborator") return addCollaborator(input || {}, user);
  return { text: `Unknown skill ${name}.`, isError: true };
}

module.exports = { SKILL_DEFS, SKILL_NAMES, runSkill, fub, getMyCallList, endOfTodayPacific, allUsers };
