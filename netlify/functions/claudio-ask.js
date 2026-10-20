// Claudio's brain: one spoken request from the Chrome extension in, one short
// spoken answer (plus an optional call list) out. Claude reaches Follow Up
// Boss through FUB's official MCP server using the *agent's own* OAuth token,
// so every lookup and write runs with that agent's FUB permissions.
const Anthropic = require("@anthropic-ai/sdk");
const { MCP_URL, convoStore, accessTokenFor, currentUserFor, json } = require("../lib/claudio");

const MODEL = process.env.CLAUDIO_MODEL || "claude-opus-5-5";
const MAX_PAUSE_CONTINUATIONS = 4;
// Older turns still in a conversation after this long are dropped so a
// forgotten panel doesn't drag a huge history into the next question.
const CONVERSATION_IDLE_MS = 30 * 60 * 1000;

const SYSTEM_PROMPT = `You are Claudio, a voice assistant built into Follow Up Boss (FUB) for Power Real Estate Group agents.

You reach FUB only through the Follow Up Boss tools. The person talking to you is the signed-in FUB user, given with each request. "My leads" means people assigned to them: pass their FUB name exactly as given to query_people's assignedTo. assignedTo matches names only, never an email. If the signed-in user is not given, call get-current-user once and use the name it returns.

How you answer:
- Your answer is read aloud. "speech" must be 1-3 short sentences, natural spoken language, no markdown, no URLs, no IDs.
- Reply in the language the agent spoke (English or Spanish).
- "display" is a short written version for the panel (plain text, can use line breaks).
- Put people the agent should act on (call lists, search results, the lead you just updated) in "items", up to 25. Use real FUB person ids and phone numbers from tool results; never invent them. Use null when unknown. "detail" is a few words, e.g. stage and last activity.

Call lists ("make me a smart list", "who should I call"):
- Use query_people with the filters they asked for (stage, tags, source, assigned to me), sorted so the stalest contact comes first. Put the people in "items" and say how many there are in total.
- You cannot create real FUB Smart Lists. Call it a "call list" and never say you created a smart list.
- Do not call any render_* tools; the extension draws its own list.

Writes (notes, stage changes, tasks, new contacts, appointments, pausing an action plan):
- First call the tool WITHOUT confirmed=true to get the proposal. Read the change back in "speech" and set "needs_confirmation" to true.
- Only after the agent clearly says yes in the next turn, call it again with confirmed=true. If they say no, drop it.
- Texts and emails are drafts only: draft them and tell the agent to send from FUB.

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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!process.env.ANTHROPIC_API_KEY) return json(500, { error: "ANTHROPIC_API_KEY is not set on Netlify" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "invalid JSON" });
  }
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

  const user = await currentUserFor(session, fubToken);

  const convos = convoStore();
  const convoKey = `${session}/${conversationId}`;
  const saved = await convos.get(convoKey, { type: "json" });
  const messages =
    saved && Date.now() - saved.updatedAt < CONVERSATION_IDLE_MS ? saved.messages : [];
  messages.push({ role: "user", content: `${describePage(page, user)}\n\nAgent said: ${text.slice(0, 2000)}` });

  const client = new Anthropic();
  const request = {
    model: MODEL,
    max_tokens: 8000,
    betas: ["mcp-client-2025-11-20", "server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: process.env.CLAUDIO_EFFORT || "low",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    mcp_servers: [{ type: "url", url: MCP_URL, name: "fub", authorization_token: fubToken }],
    tools: [{ type: "mcp_toolset", mcp_server_name: "fub" }],
    messages,
  };

  let response;
  try {
    response = await client.beta.messages.create(request);
    // Long tool loops can pause server-side; hand the partial turn back to continue.
    for (let i = 0; response.stop_reason === "pause_turn" && i < MAX_PAUSE_CONTINUATIONS; i++) {
      messages.push({ role: "assistant", content: response.content });
      response = await client.beta.messages.create({ ...request, messages });
    }
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return json(429, { error: "busy", speech: "I'm a little busy right now. Try again in a few seconds." });
    }
    if (err instanceof Anthropic.APIError) {
      console.error("Claudio Claude API error:", err.status, err.message);
      // The FUB MCP server rejecting the agent's token surfaces as a 400 here.
      if (/authoriz|401|unauthor/i.test(err.message)) return json(401, { error: "reconnect" });
      return json(502, { error: "claude_api", speech: "I couldn't reach Follow Up Boss just now. Please try again." });
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

  messages.push({ role: "assistant", content: response.content });
  await convos.setJSON(convoKey, { messages, updatedAt: Date.now() });

  console.log(
    `Claudio ok model=${response.model} stop=${response.stop_reason} in=${response.usage?.input_tokens} out=${response.usage?.output_tokens} items=${answer.items.length}`
  );
  return json(200, answer);
};
