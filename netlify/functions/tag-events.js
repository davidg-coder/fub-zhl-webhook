// Returns the logged tag-add events the recruiting dashboard's hand-raiser
// tracker cares about, so it can find contacts that already existed in FUB
// and got a new campaign tag — invisible to any filter based on `created`.
const { getStore } = require("@netlify/blobs");

// The underlying "all-tag-events" store holds every tag added to any person
// account-wide (90-day retention for most, 365 for these) — mostly noise
// the dashboard never uses (RealScout/Fello/Zillow/etc.). Returning that
// full log blew past Netlify's 6MB function response cap and made every
// dashboard request fail with a 502. Filtering here to just the tags the
// dashboard's CURATED_TAGS actually reads keeps the payload small. Must be
// kept in sync with LONG_RETENTION_TAGS in fub-webhook.js and
// RECRUITING_TAGS/HOMEVALUE_TAGS in fub_recruiting_streamlit.py.
const CURATED_TAGS = new Set([
  "Courted.io",
  "Courted.io - Recruiting Auto",
  "Courted.io - Handraiser",
  "meta ads (recruiting)",
  "Join Power",
  "Join Power | Meta Ads | Reclutamiento 2/24/26",
  "Form: Join Power",
  "Reclutamiento 2/24/26",
  "leadngage_recruitment_sh",
  "recruiting_facebook_webdrvn",
  "resubido_agents_recruitment",
  "this person requested to join Power",
  "homevalue_website_webdrvn",
  "homevalue_facebook_webdrvn",
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
    name: "all-tag-events",
    siteID: process.env.SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
  const events = (await store.get("events", { type: "json" })) || [];
  const filtered = events.filter((e) => CURATED_TAGS.has(e.tag));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: filtered }),
  };
};
