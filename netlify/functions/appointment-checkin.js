// Every 15 minutes: find FUB appointments that ended over an hour ago and DM
// the agent on Slack to ask how it went (see lib/checkin.js). Also sends the
// next-morning reminder for check-ins nobody answered.
const { schedule } = require("@netlify/functions");
const { scanAndAsk } = require("../lib/checkin");

const handler = async () => {
  try {
    await scanAndAsk();
  } catch (err) {
    console.error("Check-in scan failed:", err);
  }
  return { statusCode: 200 };
};

exports.handler = schedule("*/15 * * * *", handler);
