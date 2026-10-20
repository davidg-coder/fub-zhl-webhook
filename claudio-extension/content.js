// Claudio UI injected into every Follow Up Boss page: a floating avatar button
// and a chat panel. Speech-to-text and text-to-speech run in the browser; the
// question goes to background.js, which calls the Netlify backend.
(() => {
  if (window.__claudioLoaded) return;
  window.__claudioLoaded = true;

  const CONVERSATION_IDLE_MS = 15 * 60 * 1000;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const AVATAR = chrome.runtime.getURL("icons/claudio.png");

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
      hello: "Hi, I'm Claudio 👋",
      hint: "Tap my face or the mic and ask me anything about your leads.",
      suggestions: ["Who should I call today?", "Make me a call list of my leads in Met with customer", "What tasks do I have due today?"],
      ready: "Ready to help",
      listening: "Listening…",
      thinking: "Thinking…",
      placeholder: "Ask Claudio…",
      connect: "Connect my FUB account",
      connectHint: "Sign in once with Follow Up Boss so I can see your leads.",
      connecting: "Finish signing in on the tab that just opened…",
      yes: "Yes, do it",
      no: "Cancel",
      newChat: "New conversation",
      mute: "Mute voice",
      unmute: "Turn voice on",
      lang: "Switch language",
      close: "Close",
      call: "Call",
      open: "Open in FUB",
      people: (n) => `${n} ${n === 1 ? "person" : "people"}`,
      noMic: "Voice isn't supported in this browser. You can still type.",
      micBlocked: "Microphone is blocked. Allow it for followupboss.com in the address bar.",
      disconnect: "Sign out",
      fab: "Ask Claudio (Alt+C)",
    },
    "es-US": {
      hello: "Hola, soy Claudio 👋",
      hint: "Toca mi cara o el micrófono y pregúntame lo que quieras de tus leads.",
      suggestions: ["¿A quién debo llamar hoy?", "Hazme una lista de llamadas con mis leads en Met with customer", "¿Qué tareas tengo para hoy?"],
      ready: "Listo para ayudarte",
      listening: "Escuchando…",
      thinking: "Pensando…",
      placeholder: "Pregúntale a Claudio…",
      connect: "Conectar mi cuenta de FUB",
      connectHint: "Inicia sesión una vez con Follow Up Boss para que pueda ver tus leads.",
      connecting: "Termina de iniciar sesión en la pestaña que se abrió…",
      yes: "Sí, hazlo",
      no: "Cancelar",
      newChat: "Nueva conversación",
      mute: "Silenciar voz",
      unmute: "Activar voz",
      lang: "Cambiar idioma",
      close: "Cerrar",
      call: "Llamar",
      open: "Abrir en FUB",
      people: (n) => `${n} ${n === 1 ? "persona" : "personas"}`,
      noMic: "Este navegador no soporta voz. Puedes escribir.",
      micBlocked: "El micrófono está bloqueado. Permítelo para followupboss.com en la barra de direcciones.",
      disconnect: "Cerrar sesión",
      fab: "Pregúntale a Claudio (Alt+C)",
    },
  };
  const t = (key) => T[state.lang][key];

  const ICONS = {
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="m22 9-6 6M16 9l6 6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>',
  };

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
      * { box-sizing: border-box; font-family: "Inter", -apple-system, "Segoe UI", Roboto, sans-serif; }
      svg { width: 18px; height: 18px; display: block; }

      /* Floating avatar button */
      .fab { position: fixed; right: 24px; bottom: 92px; z-index: 2147483646; width: 64px; height: 64px; padding: 3px;
        border: 0; border-radius: 50%; cursor: pointer; background: linear-gradient(135deg, #38bdf8, #2563eb 55%, #1e3a8a);
        box-shadow: 0 10px 28px rgba(37,99,235,.45), 0 0 0 1px rgba(255,255,255,.6) inset;
        transition: transform .2s cubic-bezier(.2,.8,.2,1), box-shadow .2s; }
      .fab:hover { transform: translateY(-2px) scale(1.05); box-shadow: 0 14px 34px rgba(37,99,235,.55); }
      .fab img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; border: 2px solid #fff; }
      .fab .badge { position: absolute; right: -2px; bottom: -2px; width: 24px; height: 24px; border-radius: 50%;
        background: #2563eb; color: #fff; display: grid; place-items: center; border: 2px solid #fff;
        box-shadow: 0 2px 6px rgba(0,0,0,.2); transition: background .2s; }
      .fab .badge svg { width: 12px; height: 12px; }
      .fab.listening { animation: ring 1.4s ease-out infinite; }
      .fab.listening .badge { background: #ef4444; }
      .fab.busy { background: conic-gradient(from 0deg, #38bdf8, #2563eb, #a78bfa, #38bdf8); animation: spin 1.6s linear infinite; }
      .fab.busy img { animation: spin 1.6s linear infinite reverse; }
      @keyframes ring { 0% { box-shadow: 0 0 0 0 rgba(239,68,68,.5), 0 10px 28px rgba(37,99,235,.45); }
        100% { box-shadow: 0 0 0 22px rgba(239,68,68,0), 0 10px 28px rgba(37,99,235,.45); } }
      @keyframes spin { to { transform: rotate(360deg); } }

      /* Panel */
      .panel { position: fixed; right: 24px; bottom: 170px; z-index: 2147483647; width: 400px; max-width: calc(100vw - 32px);
        height: min(640px, calc(100vh - 200px)); display: flex; flex-direction: column; background: #f6f8fc; color: #0f172a;
        border-radius: 22px; overflow: hidden; font-size: 14px;
        box-shadow: 0 24px 60px rgba(15,23,42,.28), 0 0 0 1px rgba(15,23,42,.06);
        opacity: 0; transform: translateY(12px) scale(.98); pointer-events: none; transform-origin: bottom right;
        transition: opacity .18s ease, transform .22s cubic-bezier(.2,.8,.2,1); }
      .panel.open { opacity: 1; transform: none; pointer-events: auto; }

      .head { display: flex; align-items: center; gap: 12px; padding: 14px 14px 14px 16px; color: #fff;
        background: radial-gradient(120% 140% at 0% 0%, #1d4ed8 0%, #0b1a4a 55%, #070f2b 100%); }
      .head .ava { width: 42px; height: 42px; border-radius: 50%; padding: 2px; flex: none;
        background: linear-gradient(135deg, #7dd3fc, #2563eb); box-shadow: 0 0 16px rgba(56,189,248,.55); }
      .head .ava img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }
      .head .title { flex: 1; min-width: 0; }
      .head .name { font-weight: 700; font-size: 16px; letter-spacing: .2px; }
      .head .sub { font-size: 12px; color: #bfdbfe; display: flex; align-items: center; gap: 6px; }
      .head .dot { width: 7px; height: 7px; border-radius: 50%; background: #34d399; box-shadow: 0 0 8px #34d399; }
      .head .dot.listening { background: #f87171; box-shadow: 0 0 8px #f87171; animation: blink 1s infinite; }
      .head .dot.busy { background: #fbbf24; box-shadow: 0 0 8px #fbbf24; animation: blink 1s infinite; }
      @keyframes blink { 50% { opacity: .35; } }
      .ib { width: 32px; height: 32px; border-radius: 10px; border: 0; cursor: pointer; display: grid; place-items: center;
        background: rgba(255,255,255,.1); color: #e0e7ff; transition: background .15s; font-size: 11px; font-weight: 700; }
      .ib:hover { background: rgba(255,255,255,.22); color: #fff; }
      .ib svg { width: 16px; height: 16px; }
      .tools { display: flex; gap: 6px; }

      .body { padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 12px; scroll-behavior: smooth; }
      .body::-webkit-scrollbar { width: 6px; } .body::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }

      .msg { display: flex; gap: 8px; align-items: flex-end; animation: rise .25s ease; }
      @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
      .msg.me { justify-content: flex-end; }
      .msg .mini { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; flex: none; box-shadow: 0 0 0 2px #fff, 0 2px 6px rgba(37,99,235,.3); }
      .bubble { max-width: 84%; padding: 10px 13px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
      .me .bubble { background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; border-radius: 16px 16px 4px 16px;
        box-shadow: 0 4px 12px rgba(37,99,235,.25); }
      .bot .bubble { background: #fff; color: #0f172a; border-radius: 16px 16px 16px 4px; box-shadow: 0 1px 3px rgba(15,23,42,.08); }
      .bubble.live { color: #64748b; font-style: italic; }

      .typing { display: inline-flex; gap: 4px; padding: 4px 2px; }
      .typing i { width: 7px; height: 7px; border-radius: 50%; background: #93c5fd; animation: bounce 1.2s infinite; }
      .typing i:nth-child(2) { animation-delay: .15s; } .typing i:nth-child(3) { animation-delay: .3s; }
      @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .6; } 30% { transform: translateY(-5px); opacity: 1; } }
      .wave { display: inline-flex; gap: 3px; align-items: center; height: 18px; margin-right: 6px; vertical-align: middle; }
      .wave i { width: 3px; border-radius: 2px; background: #ef4444; animation: wave 1s ease-in-out infinite; }
      .wave i:nth-child(1) { height: 6px; } .wave i:nth-child(2) { height: 14px; animation-delay: .1s; }
      .wave i:nth-child(3) { height: 9px; animation-delay: .2s; } .wave i:nth-child(4) { height: 16px; animation-delay: .3s; }
      @keyframes wave { 50% { transform: scaleY(.4); } }

      .list { background: #fff; border-radius: 16px; box-shadow: 0 1px 3px rgba(15,23,42,.08); overflow: hidden; animation: rise .3s ease; }
      .list .cap { padding: 10px 14px; font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: .5px;
        border-bottom: 1px solid #f1f5f9; }
      .row { display: flex; align-items: center; gap: 10px; padding: 10px 12px 10px 14px; border-top: 1px solid #f1f5f9; transition: background .12s; }
      .row:first-of-type { border-top: 0; }
      .row:hover { background: #f8fafc; }
      .initials { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; flex: none;
        font-size: 12px; font-weight: 700; color: #fff; }
      .row .who { flex: 1; min-width: 0; }
      .row .nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .row .dt { font-size: 12px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .act { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; flex: none; text-decoration: none;
        transition: transform .12s, background .12s; }
      .act:hover { transform: scale(1.08); }
      .act svg { width: 15px; height: 15px; }
      .act.call { background: #dcfce7; color: #15803d; } .act.call:hover { background: #bbf7d0; }
      .act.open { background: #dbeafe; color: #1d4ed8; } .act.open:hover { background: #bfdbfe; }

      .pill { border: 0; border-radius: 999px; padding: 9px 16px; font-size: 13px; font-weight: 600; cursor: pointer; transition: transform .12s, box-shadow .12s; }
      .pill:hover { transform: translateY(-1px); }
      .pill.primary { background: linear-gradient(135deg, #3b82f6, #1d4ed8); color: #fff; box-shadow: 0 4px 12px rgba(37,99,235,.3); }
      .pill.ghost { background: #fff; color: #334155; box-shadow: 0 0 0 1px #e2e8f0 inset; }
      .confirm { display: flex; gap: 8px; padding-left: 34px; }

      .welcome { margin: auto 0; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 8px 6px; }
      .welcome .big { width: 96px; height: 96px; border-radius: 50%; padding: 3px; background: linear-gradient(135deg, #7dd3fc, #2563eb, #1e3a8a);
        box-shadow: 0 12px 30px rgba(37,99,235,.35); animation: float 4s ease-in-out infinite; }
      .welcome .big img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; border: 3px solid #fff; }
      @keyframes float { 50% { transform: translateY(-5px); } }
      .welcome h3 { margin: 6px 0 0; font-size: 18px; font-weight: 700; color: #0f172a; }
      .welcome p { margin: 0; color: #64748b; line-height: 1.5; max-width: 290px; }
      .chips { display: flex; flex-direction: column; gap: 8px; width: 100%; margin-top: 8px; }
      .chip { text-align: left; border: 0; background: #fff; color: #1e3a8a; border-radius: 12px; padding: 10px 14px; font-size: 13px;
        cursor: pointer; box-shadow: 0 0 0 1px #e2e8f0 inset; transition: box-shadow .15s, transform .12s; }
      .chip:hover { box-shadow: 0 0 0 1.5px #60a5fa inset, 0 4px 10px rgba(37,99,235,.12); transform: translateY(-1px); }

      .foot { padding: 12px 14px 14px; background: #f6f8fc; }
      .bar { display: flex; align-items: center; gap: 6px; background: #fff; border-radius: 999px; padding: 5px 5px 5px 16px;
        box-shadow: 0 0 0 1px #e2e8f0, 0 4px 14px rgba(15,23,42,.06); transition: box-shadow .15s; }
      .bar:focus-within { box-shadow: 0 0 0 2px #60a5fa, 0 4px 14px rgba(37,99,235,.15); }
      .bar input { flex: 1; min-width: 0; border: 0; outline: none; font-size: 14px; background: transparent; color: #0f172a; }
      .bar input::placeholder { color: #94a3b8; }
      .round { width: 38px; height: 38px; border-radius: 50%; border: 0; cursor: pointer; display: grid; place-items: center; flex: none;
        color: #fff; background: linear-gradient(135deg, #3b82f6, #1d4ed8); box-shadow: 0 4px 10px rgba(37,99,235,.35); transition: transform .12s; }
      .round:hover { transform: scale(1.06); }
      .round.rec { background: linear-gradient(135deg, #f87171, #dc2626); box-shadow: 0 4px 10px rgba(220,38,38,.35); animation: ring 1.4s infinite; }
      .round.send { display: none; } .bar.typing .round.send { display: grid; } .bar.typing .round.mic { display: none; }
    </style>
    <button class="fab" aria-label="Claudio"><img alt="Claudio" /><span class="badge"></span></button>
    <div class="panel" role="dialog" aria-label="Claudio">
      <div class="head">
        <div class="ava"><img alt="" /></div>
        <div class="title">
          <div class="name">Claudio</div>
          <div class="sub"><span class="dot"></span><span class="status-text"></span></div>
        </div>
        <div class="tools">
          <button class="ib" data-act="lang"></button>
          <button class="ib" data-act="mute"></button>
          <button class="ib" data-act="new"></button>
          <button class="ib" data-act="disconnect"></button>
          <button class="ib" data-act="close"></button>
        </div>
      </div>
      <div class="body"></div>
      <div class="foot">
        <div class="bar">
          <input type="text" />
          <button class="round mic" data-act="mic"></button>
          <button class="round send" data-act="send"></button>
        </div>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (sel) => root.querySelector(sel);
  const fab = $(".fab");
  const panel = $(".panel");
  const bodyEl = $(".body");
  const bar = $(".bar");
  const input = $(".bar input");
  fab.querySelector("img").src = AVATAR;
  $(".head .ava img").src = AVATAR;
  $('[data-act="new"]').innerHTML = ICONS.plus;
  $('[data-act="disconnect"]').innerHTML = ICONS.logout;
  $('[data-act="close"]').innerHTML = ICONS.close;
  $('[data-act="send"]').innerHTML = ICONS.send;

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  }

  function avatarImg(cls) {
    const img = el("img", { class: cls, alt: "" });
    img.src = AVATAR;
    return img;
  }

  function botMsg(content) {
    const row = el("div", { class: "msg bot" });
    const bubble = el("div", { class: "bubble" });
    if (typeof content === "string") bubble.textContent = content;
    else bubble.append(content);
    row.append(avatarImg("mini"), bubble);
    return row;
  }

  // mode: undefined | "listening" | "thinking"; live = interim transcript
  function render(mode, live) {
    $('[data-act="lang"]').textContent = state.lang === "es-US" ? "ES" : "EN";
    $('[data-act="lang"]').title = t("lang");
    $('[data-act="mute"]').innerHTML = state.muted ? ICONS.muted : ICONS.sound;
    $('[data-act="mute"]').title = state.muted ? t("unmute") : t("mute");
    $('[data-act="new"]').title = t("newChat");
    $('[data-act="disconnect"]').title = t("disconnect");
    $('[data-act="disconnect"]').style.display = state.connected ? "" : "none";
    $('[data-act="close"]').title = t("close");
    input.placeholder = t("placeholder");
    fab.title = t("fab");

    const micBtn = $('[data-act="mic"]');
    micBtn.innerHTML = state.listening ? ICONS.stop : ICONS.mic;
    micBtn.classList.toggle("rec", state.listening);
    fab.classList.toggle("listening", state.listening);
    fab.classList.toggle("busy", state.busy);
    fab.querySelector(".badge").innerHTML = state.listening ? ICONS.stop : ICONS.mic;

    const dot = $(".head .dot");
    dot.className = `dot ${state.listening ? "listening" : state.busy ? "busy" : ""}`;
    $(".status-text").textContent = state.listening ? t("listening") : state.busy ? t("thinking") : t("ready");

    bodyEl.replaceChildren();
    if (!state.connected) {
      const w = el("div", { class: "welcome" });
      const big = el("div", { class: "big" });
      big.append(avatarImg(""));
      w.append(big, el("h3", {}, t("hello")));
      if (state.connecting) {
        w.append(el("p", {}, t("connecting")));
      } else {
        w.append(el("p", {}, t("connectHint")), el("button", { class: "pill primary", "data-act": "connect" }, t("connect")));
      }
      bodyEl.append(w);
      return;
    }

    const a = state.answer;
    if (!a && mode !== "listening") {
      const w = el("div", { class: "welcome" });
      const big = el("div", { class: "big" });
      big.append(avatarImg(""));
      const chips = el("div", { class: "chips" });
      for (const s of t("suggestions")) chips.append(el("button", { class: "chip", "data-say": s }, s));
      w.append(big, el("h3", {}, t("hello")), el("p", {}, t("hint")), chips);
      bodyEl.append(w);
      return;
    }

    if (a && a.question) {
      const me = el("div", { class: "msg me" });
      me.append(el("div", { class: "bubble" }, a.question));
      bodyEl.append(me);
    }

    if (mode === "listening") {
      const me = el("div", { class: "msg me" });
      const bubble = el("div", { class: "bubble live" });
      bubble.style.background = "#fff";
      const wave = el("span", { class: "wave" });
      wave.innerHTML = "<i></i><i></i><i></i><i></i>";
      bubble.append(wave, document.createTextNode(live || t("listening")));
      me.append(bubble);
      bodyEl.replaceChildren(me);
    } else if (mode === "thinking") {
      const dots = el("span", { class: "typing" });
      dots.innerHTML = "<i></i><i></i><i></i>";
      bodyEl.append(botMsg(dots));
    } else if (a) {
      bodyEl.append(botMsg(a.display || a.speech || ""));
      if (a.items && a.items.length) bodyEl.append(renderItems(a.items));
      if (a.needs_confirmation) {
        const row = el("div", { class: "confirm" });
        row.append(
          el("button", { class: "pill primary", "data-act": "yes" }, t("yes")),
          el("button", { class: "pill ghost", "data-act": "no" }, t("no"))
        );
        bodyEl.append(row);
      }
    }
    bodyEl.scrollTop = 0;
  }

  const HUES = [217, 262, 190, 152, 330, 24, 280, 200];
  function initials(name) {
    const parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }
  function hueFor(name) {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return HUES[h % HUES.length];
  }

  function renderItems(items) {
    const list = el("div", { class: "list" });
    list.append(el("div", { class: "cap" }, t("people")(items.length)));
    for (const item of items) {
      const row = el("div", { class: "row" });
      const ini = el("div", { class: "initials" }, initials(item.name));
      const hue = hueFor(item.name);
      ini.style.background = `linear-gradient(135deg, hsl(${hue} 80% 62%), hsl(${hue} 70% 45%))`;
      const who = el("div", { class: "who" });
      who.append(el("div", { class: "nm" }, item.name || "—"));
      if (item.detail) who.append(el("div", { class: "dt" }, item.detail));
      row.append(ini, who);
      if (item.phone) {
        const call = el("a", { class: "act call", href: `tel:${item.phone.replace(/[^\d+]/g, "")}`, title: `${t("call")} ${item.phone}` });
        call.innerHTML = ICONS.phone;
        row.append(call);
      }
      if (item.person_id) {
        const open = el("a", { class: "act open", href: `${location.origin}/2/people/view/${item.person_id}`, title: t("open") });
        open.innerHTML = ICONS.arrow;
        row.append(open);
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
    if (state.busy) return;
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
      render("listening", `${finalText}${interim}`);
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
    render("listening");
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
    render("thinking");

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

  function submitTyped() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    bar.classList.remove("typing");
    send(text);
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
    const chip = e.target.closest("[data-say]");
    if (chip) {
      send(chip.getAttribute("data-say"));
      return;
    }
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
      if (window.speechSynthesis) speechSynthesis.cancel();
      resetConversation();
      render();
    } else if (act === "mic") {
      listen();
    } else if (act === "send") {
      submitTyped();
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

  input.addEventListener("input", () => bar.classList.toggle("typing", Boolean(input.value.trim())));
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep FUB's own keyboard shortcuts from firing
    if (e.key === "Enter") submitTyped();
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
