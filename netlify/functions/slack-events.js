// Slack Events API + interactivity endpoint for Claudio's appointment
// check-ins. Slack wants an answer within 3 seconds, so this only verifies the
// signature, acks, and hands the raw request to claudio-checkin-background
// (which verifies it again before acting).
const { verifySlack } = require("../lib/checkin");

const SITE = process.env.URL || "https://fub-zhl-webhook.netlify.app";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";
  if (!verifySlack(raw, event.headers)) return { statusCode: 401, body: "bad signature" };

  if ((event.headers["content-type"] || "").includes("application/json")) {
    const body = JSON.parse(raw);
    if (body.type === "url_verification") return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: body.challenge };
  }
  // Slack retries when we're slow; the first delivery is already being handled.
  if (event.headers["x-slack-retry-num"]) return { statusCode: 200, body: "" };

  await fetch(`${SITE}/.netlify/functions/claudio-checkin-background`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      raw,
      timestamp: event.headers["x-slack-request-timestamp"],
      signature: event.headers["x-slack-signature"],
    }),
  }).catch((err) => console.error("Check-in handoff failed:", err.message));
  return { statusCode: 200, body: "" };
};
