// Returns the logged ZHL tag-add events so the Streamlit dashboard can filter
// leads by the real date a tag was added, not just by team/tag membership.
const { getStore } = require("@netlify/blobs");

// Tags added to fub-webhook.js's ZHL_TAGS on 2026-10-27. Before that they were
// only kept in the 90-day "all-tag-events" log, so any of those events still
// there get copied into the permanent ZHL log the first time they're read.
const BACKFILL_TAGS = new Set([
  "ZHL Transferred",
  "Zillow zhl Status: Contacting",
  "Zillow zhl Status: Contact Made",
  "Zillow zhl Status: No Longer Active",
]);

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
    name: "zhl-tag-events",
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
  const events = (await store.get("events", { type: "json" })) || [];

  const allTagsStore = getStore({
    name: "all-tag-events",
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
  const allEvents = (await allTagsStore.get("events", { type: "json" })) || [];
  const seen = new Set(events.map((e) => `${e.personId}|${e.tag}|${e.addedAt}`));
  const backfill = allEvents.filter(
    (e) => BACKFILL_TAGS.has(e.tag) && !seen.has(`${e.personId}|${e.tag}|${e.addedAt}`)
  );
  if (backfill.length > 0) {
    events.push(...backfill.map(({ personId, tag, addedAt }) => ({ personId, tag, addedAt })));
    await store.setJSON("events", events);
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  };
};
