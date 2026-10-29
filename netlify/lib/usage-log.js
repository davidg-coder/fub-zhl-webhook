// Logs the tokens each Claude call uses, so claudio-spend-report can estimate
// weekly API spend without an Anthropic Admin key. Each call is one empty blob
// whose key carries all the data (day/source/model/user/tokens), so the report
// reads a whole week with a single list() and no per-blob gets, and parallel
// calls never overwrite each other.
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

// USD per million tokens. Cache reads bill at 0.1x input, 5-minute cache
// writes at 1.25x input. Update when Anthropic changes prices.
const PRICES = {
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
};

const usageStore = () =>
  getStore({ name: "claude-usage", siteID: process.env.SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });

const pacificDay = (date = new Date()) => date.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

// Adds one response's usage into a running total.
function addUsage(total, usage) {
  if (!usage) return total;
  total.in += usage.input_tokens || 0;
  total.cacheRead += usage.cache_read_input_tokens || 0;
  total.cacheWrite += usage.cache_creation_input_tokens || 0;
  total.out += usage.output_tokens || 0;
  return total;
}

const emptyUsage = () => ({ in: 0, cacheRead: 0, cacheWrite: 0, out: 0 });

function costOf(model, t) {
  const p = PRICES[String(model).replace(/-\d{8}$/, "")] || PRICES["claude-opus-5-5"];
  return (t.in * p.in + t.cacheRead * p.in * 0.1 + t.cacheWrite * p.in * 1.25 + t.out * p.out) / 1e6;
}

// source: "claudio" or "checkin". Never throws: spend tracking must not break answers.
async function logUsage(source, model, total, fubUserId) {
  try {
    if (!total.in && !total.out) return;
    const key = [
      pacificDay(),
      source,
      String(model).replace(/[^\w.-]/g, ""),
      fubUserId || 0,
      `${total.in}-${total.cacheRead}-${total.cacheWrite}-${total.out}`,
      `${Date.now()}${crypto.randomBytes(3).toString("hex")}`,
    ].join("/");
    await usageStore().set(key, "");
  } catch (err) {
    console.error("Usage log failed:", err.message);
  }
}

// Every logged call from `fromDay` to `toDay` (inclusive, YYYY-MM-DD Pacific).
async function readUsage(fromDay, toDay) {
  // One list per month touched (keys start with YYYY-MM-DD), not the whole store.
  const months = [...new Set([fromDay.slice(0, 7), toDay.slice(0, 7)])];
  const keys = [];
  for (const prefix of months) keys.push(...(await usageStore().list({ prefix })).blobs.map((b) => b.key));
  const rows = [];
  for (const key of keys) {
    const [day, source, model, user, tokens] = key.split("/");
    if (day < fromDay || day > toDay) continue;
    const [inT, cacheRead, cacheWrite, out] = tokens.split("-").map(Number);
    const t = { in: inT, cacheRead, cacheWrite, out };
    rows.push({ day, source, model, fubUserId: Number(user), tokens: t, cost: costOf(model, t) });
  }
  return rows;
}

module.exports = { addUsage, emptyUsage, logUsage, readUsage, pacificDay, usageStore };
