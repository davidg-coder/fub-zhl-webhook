// Returns the logged tag-add events the VTK Dashboard's tag-tracking section
// cares about, so it can track VENDE TU KASA leads by campaign tag date
// instead of (or alongside) their FUB `created` date.
const { getStore } = require("@netlify/blobs");

// The underlying "all-tag-events" store holds every tag added to any person
// account-wide. Filtering here to just the VTK campaign tags keeps the
// response well under Netlify's 6MB cap (see tag-events.js, which hit this
// with the full log). Must be kept in sync with VTK_CAMPAIGN_TAGS in
// fub-webhook.js.
const CURATED_TAGS = new Set([
  "Vende Tu Kasa",
  "VendeTuKasa",
  "leadngage_vendetukasa",
  "#VTKSellernocontact",
  "VTK Seller - No Contact",
  "VTK - Sellers 1.5% - 2026",
  "vendetukasa (zapier-phi)",
  "VTK Cash Offers KM Follow-up",
  "San Diego - VTK",
  "K version - Cash Offers CA - Español - Octubre 2025",
  "VTK - Sellers 1.5% - 2026 - San Diego",
  "Vtk_Seller_No_Contact",
  "K version - Cash Offers CA - Español - Octubre 2025 - San Diego",
  "1. Page Name: Vende Tu Kasa",
  "resubido - san diego vtk",
  "1. Form Name: VTK - Sellers 1.5% - 2026 - San Diego",
  "Vende Tu Kasa (website)",
  "VTK (cash offer)",
  "VTK Appointment (New System)",
  "VTK_appt_Group D",
  "CASH_OFFER_DIEGO",
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
