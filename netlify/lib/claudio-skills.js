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

async function runSkill(name, input, user) {
  if (!process.env.FUB_API_KEY) return { text: "FUB_API_KEY is not set on Netlify.", isError: true };
  if (name === "move_lead_to_pond") return moveLeadToPond(input || {}, user);
  if (name === "get_lead_details") return getLeadDetails(input || {}, user);
  return { text: `Unknown skill ${name}.`, isError: true };
}

module.exports = { SKILL_DEFS, SKILL_NAMES, runSkill, fub };
