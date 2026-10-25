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

async function runSkill(name, input, user) {
  if (!process.env.FUB_API_KEY) return { text: "FUB_API_KEY is not set on Netlify.", isError: true };
  if (name === "move_lead_to_pond") return moveLeadToPond(input || {}, user);
  return { text: `Unknown skill ${name}.`, isError: true };
}

module.exports = { SKILL_DEFS, SKILL_NAMES, runSkill, fub };
