// Claudio service worker: owns the agent's session and talks to the Netlify
// backend (host_permissions lets it skip CORS). Content scripts on FUB pages
// message it with {type: "connect" | "ask" | "disconnect"}.
const API = "https://fub-zhl-webhook.netlify.app/.netlify/functions";
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_EVERY_MS = 2000;
const ASK_POLL_MS = 1500;
const ASK_TIMEOUT_MS = 3 * 60 * 1000;

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const state = randomHex(32);
  await chrome.tabs.create({ url: `${API}/claudio-oauth-start?state=${state}` });
  await chrome.storage.local.set({ claudioConnecting: true });

  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_EVERY_MS);
      const res = await fetch(`${API}/claudio-oauth-poll?state=${state}`).catch(() => null);
      if (!res || !res.ok) continue;
      const data = await res.json();
      if (data.status === "connected" && data.session) {
        await chrome.storage.local.set({ claudioSession: data.session });
        return { ok: true };
      }
    }
    return { ok: false, error: "timeout" };
  } finally {
    await chrome.storage.local.set({ claudioConnecting: false });
  }
}

// Questions run in a Netlify background function (no ~10s sync limit): start
// the job, then poll claudio-result until the answer is saved.
async function ask({ text, conversationId, page }) {
  const { claudioSession } = await chrome.storage.local.get("claudioSession");
  if (!claudioSession) return { needsConnect: true };

  const jobId = randomHex(16);
  try {
    const start = await fetch(`${API}/claudio-ask-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, session: claudioSession, conversationId, text, page }),
    });
    if (!start.ok) throw new Error(`start ${start.status}`);
  } catch {
    return { error: true, speech: "I can't reach the Claudio server. Check your internet connection." };
  }

  const deadline = Date.now() + ASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(ASK_POLL_MS);
    const res = await fetch(`${API}/claudio-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, session: claudioSession }),
    }).catch(() => null);
    if (!res) continue;
    if (res.status === 401) {
      await chrome.storage.local.remove("claudioSession");
      return { needsConnect: true };
    }
    const data = await res.json().catch(() => ({}));
    if (data.status === "pending") continue;
    if (!res.ok) {
      return {
        error: true,
        speech: data.speech || "Something went wrong on my side. Please try again.",
        display: data.display || `Something went wrong on my side (HTTP ${res.status}).`,
      };
    }
    return data;
  }
  return { error: true, speech: "That took too long. Try a narrower question." };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    connect: () => connect(),
    ask: () => ask(msg),
    disconnect: () => chrome.storage.local.remove("claudioSession").then(() => ({ ok: true })),
  };
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler().then(sendResponse, (err) => sendResponse({ error: true, speech: String(err) }));
  return true; // keep the channel open for the async response
});
