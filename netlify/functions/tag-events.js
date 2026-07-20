// Returns the logged all-tag-add events (every tag, any person, account-wide)
// so the recruiting dashboard can find contacts that already existed in FUB
// and got a new campaign tag — invisible to any filter based on `created`.
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
    name: "all-tag-events",
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
