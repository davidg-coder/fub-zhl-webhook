// Claudio UI injected into every Follow Up Boss page: a floating mic button
// and a panel. Speech-to-text and text-to-speech run in the browser; the
// question goes to background.js, which calls the Netlify backend.
(() => {
  if (window.__claudioLoaded) return;
  window.__claudioLoaded = true;

  const CONVERSATION_IDLE_MS = 15 * 60 * 1000;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  const state = {
    lang: (navigator.language || "en-US").toLowerCase().startsWith("es") ? "es-US" : "en-US",
    muted: false,
    listening: false,
    busy: false,
    connected: false,
    connecting: false,
    conversationId: null,
    lastActivity: 0,
    answer: null, // { speech, display, needs_confirmation, items, question }
  };

  const T = {
    "en-US": {
      hint: "Tap the mic and ask. Try: “Make me a call list of my leads in Met with customer.”",
      listening: "Listening…",
      thinking: "Working on it…",
      placeholder: "Or type here and press Enter",
      connect: "Connect Claudio to my FUB account",
      connecting: "Finish signing in on the tab that just opened…",
      yes: "Yes, do it",
      no: "No",
      newChat: "New",
      call: "Call",
      open: "Open",
      noMic: "Voice isn't supported in this browser. You can still type.",
      micBlocked: "Microphone is blocked. Allow it for followupboss.com in the address bar.",
      disconnect: "Sign out",
    },
    "es-US": {
      hint: "Toca el micrófono y pregunta. Prueba: “Hazme una lista de llamadas con mis leads en Met with customer.”",
      listening: "Escuchando…",
      thinking: "Trabajando en eso…",
      placeholder: "O escribe aquí y presiona Enter",
      connect: "Conectar Claudio con mi cuenta de FUB",
      connecting: "Termina de iniciar sesión en la pestaña que se abrió…",
      yes: "Sí, hazlo",
      no: "No",
      newChat: "Nueva",
      call: "Llamar",
      open: "Abrir",
      noMic: "Este navegador no soporta voz. Puedes escribir.",
      micBlocked: "El micrófono está bloqueado. Permítelo para followupboss.com en la barra de direcciones.",
      disconnect: "Cerrar sesión",
    },
  };
  const t = (key) => T[state.lang][key];

  // ---------- page context ----------
  function pageContext() {
    const m = location.pathname.match(/\/people\/view\/(\d+)/);
    const ctx = { path: location.pathname };
    if (m) {
      ctx.personId = Number(m[1]);
      const name = (document.title || "").split("|")[0].trim();
      if (name && !/follow up boss/i.test(name)) ctx.personName = name;
    }
    return ctx;
  }

  // ---------- UI ----------
  const host = document.createElement("div");
  host.id = "claudio-root";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
      .fab { position: fixed; right: 24px; bottom: 96px; z-index: 2147483646; width: 56px; height: 56px;
        border-radius: 50%; border: 0; cursor: pointer; background: #1f6feb; color: #fff; font-size: 24px;
        box-shadow: 0 6px 20px rgba(31,111,235,.45); display: grid; place-items: center; transition: transform .15s; }
      .fab:hover { transform: scale(1.06); }
      .fab.listening { background: #e5484d; animation: pulse 1.2s infinite; }
      @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(229,72,77,.55); } 100% { box-shadow: 0 0 0 18px rgba(229,72,77,0); } }
      .panel { position: fixed; right: 24px; bottom: 164px; z-index: 2147483647; width: 380px; max-width: calc(100vw - 32px);
        max-height: min(620px, calc(100vh - 200px)); display: none; flex-direction: column; background: #fff; color: #1d2433;
        border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.22); overflow: hidden; font-size: 14px; }
      .panel.open { display: flex; }
      .head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: #0f1b33; color: #fff; }
      .head b { flex: 1; font-size: 15px; }
      .chip { border: 1px solid rgba(255,255,255,.35); background: transparent; color: #fff; border-radius: 999px;
        padding: 3px 10px; font-size: 12px; cursor: pointer; }
      .body { padding: 14px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px; }
      .q { align-self: flex-end; background: #e8f0fe; color: #174ea6; padding: 8px 12px; border-radius: 12px 12px 2px 12px; max-width: 90%; }
      .a { white-space: pre-wrap; line-height: 1.45; }
      .muted { color: #6b7385; }
      .status { color: #1f6feb; font-weight: 600; }
      .list { display: flex; flex-direction: column; border: 1px solid #e6e8ef; border-radius: 12px; overflow: hidden; }
      .row { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-top: 1px solid #eef0f5; }
      .row:first-child { border-top: 0; }
      .row .who { flex: 1; min-width: 0; }
      .row .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .row .detail { font-size: 12px; color: #6b7385; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .btn { border: 1px solid #d5d9e3; background: #fff; color: #1d2433; border-radius: 8px; padding: 5px 9px;
        font-size: 12px; cursor: pointer; text-decoration: none; white-space: nowrap; }
      .btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
      .btn.big { padding: 9px 14px; font-size: 14px; }
      .confirm { display: flex; gap: 8px; }
      .foot { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #eef0f5; }
      .foot input { flex: 1; border: 1px solid #d5d9e3; border-radius: 8px; padding: 8px 10px; font-size: 14px; outline: none; }
      .foot input:focus { border-color: #1f6feb; }
    </style>
    <button class="fab" title="Claudio (Alt+C)">🎙️</button>
    <div class="panel" role="dialog" aria-label="Claudio">
      <div class="head">
        <b>Claudio</b>
        <button class="chip" data-act="lang"></button>
        <button class="chip" data-act="mute"></button>
        <button class="chip" data-act="new"></button>
        <button class="chip" data-act="close" aria-label="Close">✕</button>
      </div>
      <div class="body"></div>
      <div class="foot">
        <input type="text" />
        <button class="btn primary" data-act="mic">🎙️</button>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (sel) => root.querySelector(sel);
  const fab = $(".fab");
  const panel = $(".panel");
  const bodyEl = $(".body");
  const input = $(".foot input");

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  }

  function render(status) {
    $('[data-act="lang"]').textContent = state.lang === "es-US" ? "ES" : "EN";
    $('[data-act="mute"]').textContent = state.muted ? "🔇" : "🔊";
    $('[data-act="new"]').textContent = t("newChat");
    input.placeholder = t("placeholder");
    fab.classList.toggle("listening", state.listening);

    bodyEl.replaceChildren();
    if (!state.connected) {
      if (state.connecting) {
        bodyEl.append(el("div", { class: "status" }, t("connecting")));
      } else {
        const btn = el("button", { class: "btn primary big", "data-act": "connect" }, t("connect"));
        bodyEl.append(btn);
      }
      return;
    }

    const a = state.answer;
    if (a && a.question) bodyEl.append(el("div", { class: "q" }, a.question));
    if (status) {
      bodyEl.append(el("div", { class: "status" }, status));
    } else if (a) {
      bodyEl.append(el("div", { class: "a" }, a.display || a.speech || ""));
      if (a.items && a.items.length) bodyEl.append(renderItems(a.items));
      if (a.needs_confirmation) {
        const row = el("div", { class: "confirm" });
        row.append(
          el("button", { class: "btn primary big", "data-act": "yes" }, t("yes")),
          el("button", { class: "btn big", "data-act": "no" }, t("no"))
        );
        bodyEl.append(row);
      }
    } else {
      bodyEl.append(el("div", { class: "muted" }, t("hint")));
    }
    const signOut = el("button", { class: "btn", "data-act": "disconnect", style: "align-self:flex-start;margin-top:6px;opacity:.7" }, t("disconnect"));
    bodyEl.append(signOut);
  }

  function renderItems(items) {
    const list = el("div", { class: "list" });
    for (const item of items) {
      const row = el("div", { class: "row" });
      const who = el("div", { class: "who" });
      who.append(el("div", { class: "name" }, item.name || "—"));
      if (item.detail) who.append(el("div", { class: "detail" }, item.detail));
      row.append(who);
      if (item.phone) {
        row.append(el("a", { class: "btn", href: `tel:${item.phone.replace(/[^\d+]/g, "")}` }, `📞 ${t("call")}`));
      }
      if (item.person_id) {
        row.append(el("a", { class: "btn primary", href: `${location.origin}/2/people/view/${item.person_id}` }, t("open")));
      }
      list.append(row);
    }
    return list;
  }

  // ---------- persistence (survives FUB page navigation) ----------
  async function loadState() {
    const s = await chrome.storage.local.get([
      "claudioSession", "claudioConnecting", "claudioLang", "claudioMuted",
      "claudioConversationId", "claudioLastActivity", "claudioAnswer", "claudioPanelOpen",
    ]);
    state.connected = Boolean(s.claudioSession);
    state.connecting = Boolean(s.claudioConnecting);
    if (s.claudioLang) state.lang = s.claudioLang;
    state.muted = Boolean(s.claudioMuted);
    state.conversationId = s.claudioConversationId || null;
    state.lastActivity = s.claudioLastActivity || 0;
    state.answer = s.claudioAnswer || null;
    if (Date.now() - state.lastActivity > CONVERSATION_IDLE_MS) resetConversation(false);
    panel.classList.toggle("open", Boolean(s.claudioPanelOpen));
    render();
  }

  function save() {
    chrome.storage.local.set({
      claudioLang: state.lang,
      claudioMuted: state.muted,
      claudioConversationId: state.conversationId,
      claudioLastActivity: state.lastActivity,
      claudioAnswer: state.answer,
      claudioPanelOpen: panel.classList.contains("open"),
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("claudioSession" in changes || "claudioConnecting" in changes) {
      state.connected = Boolean(changes.claudioSession ? changes.claudioSession.newValue : state.connected);
      if ("claudioConnecting" in changes) state.connecting = Boolean(changes.claudioConnecting.newValue);
      if (!state.busy) render();
    }
  });

  function resetConversation(persist = true) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    state.conversationId = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    state.answer = null;
    state.lastActivity = Date.now();
    if (persist) save();
  }

  // ---------- speech ----------
  function speak(text) {
    if (state.muted || !text || !window.speechSynthesis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = state.lang;
    const prefix = state.lang.slice(0, 2);
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(prefix));
    u.voice = voices.find((v) => /natural|google|online/i.test(v.name)) || voices[0] || null;
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }

  let recognition = null;
  function listen() {
    if (!SpeechRecognition) {
      state.answer = { ...(state.answer || {}), display: t("noMic"), items: [] };
      render();
      input.focus();
      return;
    }
    if (state.listening) {
      recognition && recognition.stop();
      return;
    }
    if (window.speechSynthesis) speechSynthesis.cancel();

    recognition = new SpeechRecognition();
    recognition.lang = state.lang;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    let finalText = "";

    recognition.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      render(`${t("listening")} ${finalText}${interim}`);
    };
    recognition.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        state.answer = { display: t("micBlocked"), items: [] };
      }
    };
    recognition.onend = () => {
      state.listening = false;
      const text = finalText.trim();
      if (text) send(text);
      else render();
    };

    state.listening = true;
    openPanel();
    render(t("listening"));
    recognition.start();
  }

  // ---------- ask ----------
  async function send(text) {
    if (state.busy || !text.trim()) return;
    if (!state.connected) {
      render();
      return;
    }
    if (!state.conversationId || Date.now() - state.lastActivity > CONVERSATION_IDLE_MS) resetConversation(false);

    state.busy = true;
    state.answer = { question: text, items: [] };
    render(t("thinking"));

    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: "ask",
        text,
        conversationId: state.conversationId,
        page: pageContext(),
      });
    } catch (err) {
      res = { error: true, speech: "Claudio was updated. Reload this page and try again." };
    }
    state.busy = false;
    state.lastActivity = Date.now();

    if (res && res.needsConnect) {
      state.connected = false;
      state.answer = null;
      render();
      save();
      return;
    }
    state.answer = {
      question: text,
      speech: res.speech,
      display: res.display || res.speech,
      needs_confirmation: Boolean(res.needs_confirmation),
      items: Array.isArray(res.items) ? res.items : [],
    };
    render();
    save();
    speak(res.speech);
  }

  function openPanel() {
    panel.classList.add("open");
    save();
  }

  // ---------- events ----------
  fab.addEventListener("click", () => {
    if (!panel.classList.contains("open")) {
      openPanel();
      render();
      if (state.connected) listen();
    } else if (state.connected) {
      listen();
    }
  });

  root.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.getAttribute("data-act");
    if (!act) return;
    if (act === "close") {
      panel.classList.remove("open");
      if (window.speechSynthesis) speechSynthesis.cancel();
      save();
    } else if (act === "lang") {
      state.lang = state.lang === "es-US" ? "en-US" : "es-US";
      render();
      save();
    } else if (act === "mute") {
      state.muted = !state.muted;
      if (state.muted && window.speechSynthesis) speechSynthesis.cancel();
      render();
      save();
    } else if (act === "new") {
      resetConversation();
      render();
    } else if (act === "mic") {
      listen();
    } else if (act === "yes" || act === "no") {
      send(act === "yes" ? (state.lang === "es-US" ? "Sí, confirmo." : "Yes, go ahead.") : "No, cancel that.");
    } else if (act === "connect") {
      state.connecting = true;
      render();
      chrome.runtime.sendMessage({ type: "connect" }).catch(() => {});
    } else if (act === "disconnect") {
      await chrome.runtime.sendMessage({ type: "disconnect" });
      state.connected = false;
      resetConversation();
      render();
    }
  });

  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep FUB's own keyboard shortcuts from firing
    if (e.key === "Enter" && input.value.trim()) {
      const text = input.value.trim();
      input.value = "";
      send(text);
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      openPanel();
      if (state.connected) listen();
      else render();
    }
  });

  // Voices load asynchronously in Chrome.
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => {};
  loadState();
})();
