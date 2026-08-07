// Returns the logged stage-change events (every peopleStageUpdated event,
// any pipeline) so the recruiting dashboard can find "moved to Recruiting -
// Met" transitions even after the lead has since advanced past Met — FUB's
// own API only exposes a person's *current* stage, not stage history.
const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const expected = `Bearer ${process.env.DASHBOARD_TOKEN || ""}`;
  if (!process.env.DASHBOARD_TOKEN || auth !== expected) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  const store = getStore({
    name: "stage-changes",
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
  const events = (await store.get("events", { type: "json" })) || [];

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  };
};
