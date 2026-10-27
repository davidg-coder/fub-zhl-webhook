// Handles what agents do in a check-in DM, handed over by slack-events:
// tapping an outcome, replying in words or a voice clip, and tapping Save.
// Runs as a background function because drafting the plan calls Claude.
const crypto = require("crypto");
const {
  checkinStore, slack, slackGet, verifySlack, askAboutAppointment, fubList, draftPlan, planBlocks, applyPlan, pilotReport, sendMorningPlans, FUB_APP,
} = require("../lib/checkin");

exports.handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return;
  }
  const { raw, timestamp, signature } = body;
  if (typeof raw !== "string" || !verifySlack(raw, { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature })) {
    console.warn("Check-in background: bad Slack signature");
    return;
  }
  try {
    if (raw.startsWith("payload=")) {
      await onAction(JSON.parse(new URLSearchParams(raw).get("payload")));
    } else {
      const ev = JSON.parse(raw).event || {};
      if (ev.type === "message" && ev.channel_type === "im" && !ev.bot_id && (!ev.subtype || ev.subtype === "file_share")) {
        await onMessage(ev);
      }
    }
  } catch (err) {
    console.error("Check-in background failed:", err);
  }
};

async function load(apptId) {
  return checkinStore().get(`appt/${apptId}`, { type: "json" });
}

async function save(rec) {
  await checkinStore().setJSON(`appt/${rec.appt.id}`, rec);
}

const say = (rec, text, blocks) => slack("chat.postMessage", { channel: rec.channel, thread_ts: rec.ts, text, ...(blocks ? { blocks } : {}) });

// Ask Claude what to log; post either its follow-up question or the plan.
async function respond(rec) {
  let plan;
  try {
    plan = await draftPlan(rec);
  } catch (err) {
    console.error(`Check-in: plan failed for appointment ${rec.appt.id}:`, err.message);
    await say(rec, "Sorry, something went wrong on my side. Can you send that again in a minute?");
    return;
  }
  rec.transcript.push({ from: "Claudio", text: plan.reply });
  if (plan.ready) {
    rec.plan = plan;
    rec.planId = crypto.randomBytes(8).toString("hex");
    rec.status = "planned";
    await save(rec);
    await say(rec, plan.reply, planBlocks(rec, plan, rec.planId));
  } else {
    await save(rec);
    await say(rec, plan.reply);
  }
}

async function onAction(payload) {
  if (payload.type !== "block_actions") return;
  const action = (payload.actions || [])[0];
  if (!action || action.action_id === "open_fub") return;
  const value = JSON.parse(action.value || "{}");
  const rec = await load(value.appt);
  if (!rec || rec.agent.slackId !== payload.user.id) return;

  if (/^(outcome|stage):/.test(action.action_id)) {
    if (rec.status === "saved") return;
    const picked = action.text.text;
    // Swap the buttons for the choice so it can't be tapped twice.
    await slack("chat.update", {
      channel: rec.channel,
      ts: rec.ts,
      text: `Appointment with ${rec.person.name}: ${picked}`,
      blocks: [
        payload.message.blocks[0],
        { type: "context", elements: [{ type: "mrkdwn", text: `You picked *${picked}* · <${FUB_APP}/2/people/view/${rec.person.id}|Open in FUB>` }] },
      ],
    });
    rec.transcript.push({ from: "Agent", text: `${action.action_id.startsWith("stage:") ? "Picked stage" : "Outcome"}: ${picked}` });
    await respond(rec);
    return;
  }

  if (action.action_id === "save") {
    if (rec.status === "saved" || value.planId !== rec.planId) {
      await say(rec, rec.status === "saved" ? "Already saved ✅" : "That's an older draft. Tap Save on the latest one.");
      return;
    }
    let done;
    try {
      done = await applyPlan(rec);
    } catch (err) {
      console.error(`Check-in: save failed for appointment ${rec.appt.id}:`, err.message);
      await save(rec);
      const partial = rec.saved && rec.saved.length ? ` Already saved: ${rec.saved.join(", ")}.` : "";
      await say(rec, `I couldn't save everything to FUB (${String(err.message).slice(0, 200)}).${partial} Tap Save again to retry the rest.`);
      return;
    }
    rec.status = "saved";
    rec.savedAt = Date.now();
    await save(rec);
    await checkinStore().delete(`open/${rec.appt.id}`);
    await slack("chat.update", {
      channel: payload.channel.id,
      ts: payload.message.ts,
      text: `Saved to FUB for ${rec.person.name}`,
      blocks: [
        ...payload.message.blocks.filter((b) => b.type === "section"),
        { type: "context", elements: [{ type: "mrkdwn", text: `✅ Saved to FUB (${done.join(", ")}) · <${FUB_APP}/2/people/view/${rec.person.id}|Open ${rec.person.name}>` }] },
      ],
    });
    console.log(`Check-in: saved appointment ${rec.appt.id} (${done.join(",")}) by ${rec.agent.name}`);
  }
}

// Text of a message, including Slack's transcript of a voice/video clip.
// Transcripts can still be processing when the event arrives, so wait a bit.
async function messageText(ev) {
  let text = ev.text || "";
  for (const f of ev.files || []) {
    if (!/^(audio|video)\//.test(f.mimetype || "")) continue;
    let transcript = f.transcription && f.transcription.preview && f.transcription.preview.content;
    for (let i = 0; !transcript && i < 6; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const info = await slackGet("files.info", { file: f.id }).catch(() => null);
      const t = info && info.file && info.file.transcription;
      transcript = t && t.preview && t.preview.content;
      if (t && t.status === "failed") break;
    }
    if (transcript) text += `${text ? "\n" : ""}${transcript}`;
  }
  return text.trim();
}

async function onMessage(ev) {
  const store = checkinStore();
  const apptId =
    (ev.thread_ts && (await store.get(`thread/${ev.channel}/${ev.thread_ts}`))) || (await store.get(`agent/${ev.user}`));
  const rec = apptId ? await load(apptId) : null;
  const text = await messageText(ev);

  if (/^pilot$/i.test(text) && !ev.thread_ts) {
    await slack("chat.postMessage", { channel: ev.channel, text: await pilotReport() });
    return;
  }
  if (/^(plan|my day|morning)$/i.test(text) && !ev.thread_ts) {
    const email = (await slackGet("users.info", { user: ev.user })).user.profile.email;
    const me = (await fubList("/users?limit=100", "users")).find((u) => String(u.email || "").toLowerCase() === String(email || "").toLowerCase());
    if (!me) await slack("chat.postMessage", { channel: ev.channel, text: `I couldn't find a FUB user with ${email}.` });
    else await sendMorningPlans({ only: me.id });
    return;
  }
  const test = text.match(/^(?:test|check-?in)(?:\s+(.*))?$/is);
  if (test && !ev.thread_ts) {
    await testCheckin(ev, (test[1] || "").replace(/[<>]/g, "").trim());
    return;
  }
  if (!rec || rec.agent.slackId !== ev.user || rec.status === "saved") {
    await slack("chat.postMessage", {
      channel: ev.channel,
      text: "Hi! Here I only handle appointment check-ins for now. For anything else, open Claudio inside Follow Up Boss.",
    });
    return;
  }
  if (!text) {
    await say(rec, "I couldn't hear that clip. Could you type it instead?");
    return;
  }
  rec.transcript.push({ from: "Agent", text: text.slice(0, 2000) });
  await respond(rec);
}

// "test" in the DM: run a check-in now for the sender's latest appointment
// from the past week, so the flow can be tried without waiting for the scan.
// "test <lead name | FUB link | person id>" picks that lead (past 30 days).
async function testCheckin(ev, which) {
  const reply = (text) => slack("chat.postMessage", { channel: ev.channel, text });
  const email = (await slackGet("users.info", { user: ev.user })).user.profile.email;
  const users = await fubList("/users?limit=100", "users");
  const me = users.find((u) => String(u.email || "").toLowerCase() === String(email || "").toLowerCase());
  if (!me) return reply(`I couldn't find a FUB user with ${email}.`);
  const now = Date.now();
  const appts = await fubList(
    `/appointments?userId=${me.id}&start=${encodeURIComponent(new Date(now - (which ? 30 : 7) * 864e5).toISOString())}&end=${encodeURIComponent(new Date(now).toISOString())}&limit=100`,
    "appointments"
  );
  const past = appts
    .filter((a) => Date.parse(a.end || a.start) <= now && (a.invitees || []).some((i) => i.personId))
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const id = Number((which.match(/(\d{3,})\/?$/) || [])[1]);
  const pick = !which
    ? past
    : past.filter((a) =>
        (a.invitees || []).some((i) => i.personId && (i.personId === id || String(i.name || "").toLowerCase().includes(which.toLowerCase())))
      );
  if (!pick.length) {
    return reply(
      which
        ? `I couldn't find a past appointment of yours with "${which}" in the last 30 days.`
        : "You have no appointments with a lead in FUB in the past 7 days, so there's nothing to test with."
    );
  }
  const ok = await askAboutAppointment(pick[0], { agentUserId: me.id });
  if (!ok) await reply("I found your appointment but couldn't start the check-in (no lead or no Slack match).");
}
