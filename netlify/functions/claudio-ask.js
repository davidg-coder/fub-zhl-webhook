// Claudio's brain: one spoken request from the Chrome extension in, one short
// spoken answer (plus an optional call list) out. Claude reaches Follow Up
// Boss through FUB's official MCP server using the *agent's own* OAuth token,
// so every lookup and write runs with that agent's FUB permissions.
//
// We run the tool loop ourselves rather than using the API's MCP connector:
// FUB returns most tool data in structuredContent, which the connector drops
// (Claude only saw one-line summaries like "Read /users ... bounded request").
const Anthropic = require("@anthropic-ai/sdk");
const { convoStore, accessTokenFor, openMcp, currentUserFor, json } = require("../lib/claudio");
const { SKILL_DEFS, SKILL_NAMES, runSkill } = require("../lib/claudio-skills");

const MODEL = process.env.CLAUDIO_MODEL || "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 8;
// Older turns still in a conversation after this long are dropped so a
// forgotten panel doesn't drag a huge history into the next question.
const CONVERSATION_IDLE_MS = 30 * 60 * 1000;
// Tool results from earlier turns are cut to this size before saving, so a
// long conversation doesn't resend every big FUB payload on each question.
const SAVED_RESULT_CHARS = 1500;
// UI widgets (Claudio draws its own) and real sends (drafts only) are hidden.
const HIDDEN_TOOLS = /render_|send_message|call_contact/;
const TOOLS_CACHE_MS = 10 * 60 * 1000;

const SYSTEM_PROMPT = `You are Claudio, a voice assistant built into Follow Up Boss (FUB) for Power Real Estate Group agents.

You reach FUB only through the Follow Up Boss tools. The person talking to you is the signed-in FUB user, given with each request. "My leads" means people assigned to them: pass their FUB name exactly as given to query_people's assignedTo. assignedTo matches names only, never an email. When a tool takes a user id (assignedUserId, agentId), use the signed-in user's id for "me".

How you answer:
- Your answer is read aloud. "speech" must be 1-3 short sentences, natural spoken language, no markdown, no URLs, no IDs.
- Reply in the language the agent spoke (English or Spanish).
- "display" is a short written version for the panel (plain text, can use line breaks). When "items" is not empty, keep "display" to 1-2 sentences (total count, who to start with) and do not list the names; the panel already shows them. For team numbers (counts per agent), put them in "display" as short lines, highest first.
- Put people the agent should act on (call lists, search results, the lead you just updated) in "items", up to 25. Use real FUB person ids and phone numbers from tool results; never invent them. query_people results include a "phones" list for each person: use the primary one (or the first) as "phone". Use null only when the person truly has no phone. "detail" is a few words, e.g. stage and last activity.
- Be quick: use the fewest tool calls that answer the question, and small page sizes unless the question needs everything.

Call lists ("make me a smart list", "who should I call"):
- "Who should I call" / "who needs follow-up": use get_agent_follow_up_leads with the signed-in user's id as agentId (dueWindow "today", limit 10). It ranks leads by urgency. Look up phones with query_people only if needed and available.
- If a tool you planned to use is missing or fails, try another available tool that answers the same question before giving up.
- For other lists, use query_people with the filters they asked for (stage, tags, source, assigned to me), sorted so the stalest contact comes first. Put the people in "items" and say how many there are in total.
- You cannot create real FUB Smart Lists. Call it a "call list" and never say you created a smart list. You can read the agent's existing Smart Lists.

Team questions (admins and team leads):
- For "agents", list users with role Agent (get_users, limit 100, page with offset if needed), then pass their ids and names to the team tool.

Writes (notes, stage changes, tasks, new contacts, appointments, pausing an action plan):
- First call the tool WITHOUT confirmed=true to get the proposal. Proposals may include a confirmation code or token (in the result, _meta or resources) plus the tool that commits it; keep them for the next turn. Read the change back in "speech" and set "needs_confirmation" to true.
- Only after the agent clearly says yes in the next turn, commit it: call the commit tool with that code, or call the tool again with confirmed=true if that is how it works. If they say no, drop it.
- Texts and emails are drafts only: draft them and tell the agent to send from FUB.
- For a lead's stage, notes or "what's the latest", call get_lead_details (it never depends on FUB's tools being up); add other tools only for activity it doesn't cover. Never tell the agent a tool was missing or unavailable; answer with what you have.
- Moving a lead to the pond ("move/throw this lead to the pond", "remove this lead", "#movetopond"): always use move_lead_to_pond, never a tag change. It follows the same preview-then-confirmed=true flow.

The current FUB page is given with each request. "This lead", "him", "her" means the person on that page when there is one.
If a tool fails or returns nothing, say so plainly. Never guess data.`;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["speech", "display", "needs_confirmation", "items"],
  properties: {
    speech: { type: "string" },
    display: { type: "string" },
    needs_confirmation: { type: "boolean" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "person_id", "phone", "detail"],
        properties: {
          name: { type: "string" },
          person_id: { type: ["integer", "null"] },
          phone: { type: ["string", "null"] },
          detail: { type: "string" },
        },
      },
    },
  },
};

// FUB's tool list is the same for every agent, so a warm function reuses it.
let toolsCache = null;

async function fubTools(mcp) {
  if (toolsCache && Date.now() - toolsCache.at < TOOLS_CACHE_MS) return toolsCache;
  const raw = await mcp.listTools();
  const visible = raw.filter((t) => !HIDDEN_TOOLS.test(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  const defs = visible.map((t) => {
    const { $schema, ...schema } = t.inputSchema || {};
    return {
      name: t.name,
      description: (t.description || "").slice(0, 2000),
      input_schema: { ...schema, type: "object", properties: schema.properties || {} },
    };
  });
  const currentUserTool = raw.find((t) => /get-current-user$/.test(t.name))?.name;
  toolsCache = { at: Date.now(), defs, names: new Set(defs.map((d) => d.name)), currentUserTool };
  return toolsCache;
}

function describePage(page = {}, user) {
  const lines = [`Today: ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", year: "numeric", month: "long", day: "numeric" })}`];
  if (user) lines.push(`Signed-in FUB user: ${user.name} (user id ${user.id}, role ${user.role})`);
  if (page.personId) {
    lines.push(`Current FUB page: person profile, person id ${page.personId}${page.personName ? ` (${page.personName})` : ""}`);
  } else if (page.path) {
    lines.push(`Current FUB page: ${page.path}`);
  }
  return lines.join("\n");
}

function parseAnswer(response) {
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  try {
    const parsed = JSON.parse(text);
    return { ...parsed, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { speech: text || "Sorry, I didn't get an answer back.", display: text, needs_confirmation: false, items: [] };
  }
}

// Shrinks tool results from finished turns before the conversation is saved.
// The latest turn is kept whole: a write proposal's confirmation code must
// survive until the agent says yes on the next turn.
function trimForStorage(messages) {
  let latestQuestion = -1;
  messages.forEach((m, i) => {
    if (m.role === "user" && typeof m.content === "string") latestQuestion = i;
  });
  return messages.map((m, i) => {
    if (i > latestQuestion || m.role !== "user" || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((b) =>
        b.type === "tool_result" && typeof b.content === "string" && b.content.length > SAVED_RESULT_CHARS
          ? { ...b, content: `${b.content.slice(0, SAVED_RESULT_CHARS)} …[older result trimmed]` }
          : b
      ),
    };
  });
}

// Answers one request; returns a Netlify-style response. Shared by this
// synchronous endpoint and claudio-ask-background (long questions outlive the
// ~10s sync function limit, so the extension uses the background one).
async function runAsk(body) {
  if (!process.env.ANTHROPIC_API_KEY) return json(500, { error: "ANTHROPIC_API_KEY is not set on Netlify" });
  const { session, conversationId, text, page } = body;
  if (!text || typeof text !== "string") return json(400, { error: "text is required" });
  if (!/^[a-f0-9]{32}$/.test(conversationId || "")) return json(400, { error: "invalid conversationId" });

  let fubToken;
  try {
    fubToken = await accessTokenFor(session);
  } catch (err) {
    if (err.message === "SESSION_INVALID") return json(401, { error: "reconnect" });
    throw err;
  }

  let mcp, tools;
  try {
    mcp = await openMcp(fubToken);
    tools = await fubTools(mcp);
  } catch (err) {
    console.error("Claudio FUB MCP connect failed:", err.message);
    if (/\b401\b|\b403\b/.test(err.message)) return json(401, { error: "reconnect" });
    return json(502, { error: "fub_mcp", speech: "I couldn't reach Follow Up Boss just now. Please try again." });
  }
  const user = await currentUserFor(session, mcp, tools.currentUserTool);

  const convos = convoStore();
  const convoKey = `${session}/${conversationId}`;
  const saved = await convos.get(convoKey, { type: "json" });
  // History saved by the old MCP-connector version has mcp_* blocks the API
  // now rejects, so it is dropped.
  const usable =
    saved &&
    Date.now() - saved.updatedAt < CONVERSATION_IDLE_MS &&
    !JSON.stringify(saved.messages).includes('"type":"mcp_');
  const messages = usable ? saved.messages : [];
  messages.push({ role: "user", content: `${describePage(page, user)}\n\nAgent said: ${text.slice(0, 2000)}` });

  const client = new Anthropic();
  const request = {
    model: MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: process.env.CLAUDIO_EFFORT || "low",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    tools: [...tools.defs, ...SKILL_DEFS],
    // Caches the tool definitions + system prompt (tools render before system).
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  };

  const trace = [];
  let response;
  try {
    for (let round = 0; ; round++) {
      const lastRound = round >= MAX_TOOL_ROUNDS;
      response = await client.beta.messages.create({
        ...request,
        ...(lastRound ? { tool_choice: { type: "none" } } : {}),
        messages,
      });
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use" || lastRound) break;

      const calls = response.content.filter((b) => b.type === "tool_use");
      const results = await Promise.all(
        calls.map(async (call) => {
          trace.push({ call: call.name, input: call.input });
          let out;
          if (SKILL_NAMES.has(call.name)) {
            try {
              out = await runSkill(call.name, call.input, user);
            } catch (err) {
              out = { text: `Skill failed: ${err.message}`, isError: true };
            }
          } else if (!tools.names.has(call.name)) {
            out = { text: `Tool ${call.name} is not available in Claudio.`, isError: true };
          } else {
            try {
              out = await mcp.callTool(call.name, call.input);
            } catch (err) {
              out = { text: `Tool call failed: ${err.message}`, isError: true };
            }
          }
          trace.push({ result: out.isError ? "ERROR" : "ok", chars: out.text.length, preview: out.text.slice(0, 300) });
          return { type: "tool_result", tool_use_id: call.id, content: out.text, ...(out.isError ? { is_error: true } : {}) };
        })
      );
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return json(429, { error: "busy", speech: "I'm a little busy right now. Try again in a few seconds." });
    }
    if (err instanceof Anthropic.APIError) {
      console.error("Claudio Claude API error:", err.status, err.message);
      // Pilot only: show the API's reason in the panel so failures can be diagnosed.
      return json(502, {
        error: "claude_api",
        speech: "Something went wrong on my side. Please try again.",
        display: `Something went wrong on my side (${err.status}): ${String(err.message).slice(0, 400)}`,
      });
    }
    throw err;
  }

  let answer;
  if (response.stop_reason === "refusal") {
    answer = { speech: "Sorry, I can't help with that one.", display: "Request declined.", needs_confirmation: false, items: [] };
  } else {
    answer = parseAnswer(response);
    if (response.stop_reason === "max_tokens") {
      answer.speech = answer.speech || "That answer got too long. Try a narrower question.";
    }
  }

  await convos.setJSON(convoKey, { messages: trimForStorage(messages), updatedAt: Date.now() });

  for (const step of trace) console.log("Claudio tool", JSON.stringify(step));
  if (body.debug) answer.debug = trace;
  console.log(
    `Claudio ok model=${response.model} stop=${response.stop_reason} tools=${trace.length / 2} in=${response.usage?.input_tokens} cache_read=${response.usage?.cache_read_input_tokens} out=${response.usage?.output_tokens} items=${answer.items.length}`
  );
  return json(200, answer);
}

exports.runAsk = runAsk;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  return runAsk(body);
};
