# fub-zhl-webhook

Two tiny Netlify Functions that log the exact moment a "Zillow zhl Status: ..."
tag is added to a lead in Follow Up Boss, so the Power Real Estate Group
dashboard can filter ZHL leads by 7/30/60 days using the real tag-add date
instead of the contact's creation date (FUB's API doesn't expose a per-tag
timestamp anywhere else).

- `netlify/functions/fub-webhook.js` — receives FUB's `peopleTagsCreated`
  webhook, keeps only the 5 known ZHL tags, and appends `{personId, tag, addedAt}`
  to a private Netlify Blobs store.
- `netlify/functions/zhl-events.js` — read-only endpoint the dashboard calls
  (with a bearer token) to pull that log back.
- `netlify/functions/daily-summary.js` — scheduled function (runs hourly,
  only sends at 8 AM Pacific) that posts a per-office pipeline summary to a
  Slack Incoming Webhook, one message per office (Riverside/OC/LA).

Only tags added **after** this webhook is registered with FUB will have a real
date. Tags that already exist on leads today are not backfilled.

## One-time setup

1. **Create a GitHub repo** (empty, no README) and push this folder to it:
   ```
   git init
   git add -A
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin <your-new-repo-url>
   git push -u origin main
   ```
2. **Netlify → Add new site → Import an existing project → GitHub**, pick this
   repo. Netlify will run `npm install` and deploy both functions automatically.
3. **Netlify → Site settings → Environment variables**, add:
   - `DASHBOARD_TOKEN` — shared secret the Streamlit dashboard sends as
     `Authorization: Bearer <token>`. Suggested value (already generated, keep
     it private): `d5158a6a906164c142da2d6a57c9cee9e6216e9d4c0ff737`
   - `FUB_SYSTEM_KEY` — optional. If you have an X-System-Key from Follow Up
     Boss, add it here to enable signature verification on incoming webhooks.
     Safe to skip for now; the function works without it.
4. **Trigger a redeploy** so the env vars take effect.
5. Send me the resulting site URL (`https://<your-site>.netlify.app`) — I'll
   test both endpoints and then register the webhook with FUB via its API.
