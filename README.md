# fub-zhl-webhook

Two tiny Netlify Functions that log the exact moment a "Zillow zhl Status: ..."
tag is added to a lead in Follow Up Boss, so the Power Real Estate Group
dashboard can filter ZHL leads by 7/30/60 days using the real tag-add date
instead of the contact's creation date (FUB's API doesn't expose a per-tag
timestamp anywhere else).

- `netlify/functions/fub-webhook.js` — receives FUB's `peopleTagsCreated`
  webhook. Logs every tag added to any person, account-wide, to a Blobs
  store (`all-tag-events`) so the recruiting dashboard can spot hand-raiser
  re-engagements that a `created`-date filter would miss. On every write,
  prunes events older than 90 days to keep the store from growing forever —
  except the recruiting/home-value tags the dashboard's hand-raiser tracker
  is actually built for (`LONG_RETENTION_TAGS`), and the VTK (Vende Tu Kasa)
  campaign tags the VTK Dashboard's tag-tracking section reads
  (`VTK_CAMPAIGN_TAGS`), both of which get 365 days. Separately,
  if the tag is one of the 5 known ZHL status tags, also appends it to its own
  store (`zhl-tag-events`) and fires an instant Slack message when the tag
  is "Pre-approved" or "Funded".
- `netlify/functions/zhl-events.js` — read-only endpoint the sales dashboard
  calls (with a bearer token) to pull the ZHL tag log back.
- `netlify/functions/tag-events.js` — read-only endpoint the recruiting
  dashboard calls (with the same bearer token) to pull the full account-wide
  tag log back.
- `netlify/functions/vtk-tag-events.js` — same idea as `tag-events.js`, but
  filtered to the VTK campaign tags (`CURATED_TAGS`) for the VTK Dashboard's
  tag-tracking section, so it can track VENDE TU KASA leads by campaign-tag
  date alongside FUB's `created` date.
- `netlify/functions/daily-summary.js` — scheduled function (runs hourly,
  only sends at 8 AM Pacific) that posts a per-office pipeline summary to a
  Slack Incoming Webhook, one message per office (Riverside/OC/LA).
- `netlify/functions/lead-assigned-webhook.js` — receives FUB's `peopleCreated`
  webhook, looks up who each new lead is assigned to, and fires a Slack alert
  the moment an agent is assigned their 5th new lead in the current week
  (Monday–Sunday, Pacific time), listing a FUB link to each of the 5 leads.
- `netlify/functions/stage-webhook.js` — receives FUB's `peopleStageUpdated`
  webhook. Fires an instant Slack alert when a lead moves *backward* in the
  pipeline (e.g. Under Contract → Showing Homes — a strong "this deal is
  falling apart" signal), and logs every stage change to a Blobs store that
  `weekly-leaderboard.js` reads. For the recruiting stages Set/Met/Applied/
  Systems Set Up/Fully Onboarded, the logged event also includes `agent` (the
  lead's assigned recruiter at that moment) so the Power Portal's Pipeline
  Explorer can show a "Moved By" column — FUB's webhook carries no field for
  who actually performed the change, so the assigned recruiter is the closest
  available proxy. Also carries an unrelated second concern:
  when a lead whose `source` contains "zillow" reaches Submitting Offers,
  Showing Homes, Listing Agreement, or Under Contract, looks up its office
  from the "Flex Profile" custom field (`customFlexProfile` — only returned
  by the FUB API with `fields=allFields`) and posts to that office's Slack
  channel (`SLACK_WEBHOOK_ZILLOW_LA_URL` / `_OC_URL` / `_RV_URL`). Also posts
  to the Riverside channel (`SLACK_WEBHOOK_ZILLOW_RV_URL`, reused) whenever
  any Riverside-office lead — any source — reaches Appointment Set. Both
  live here instead of their own function because FUB caps active webhooks
  per event at 2, and this event's 2 slots are already taken by this
  function and `vtk-stage-webhook.js`. Leads with no Flex Profile office
  match are silently skipped.
- `netlify/functions/overdue-escalation.js` — scheduled function (runs hourly)
  that pings Slack the first time a task crosses 48 hours overdue. Only
  applies to tasks created after this function's first run — the account's
  existing backlog of stale tasks is permanently excluded, not just skipped
  on day one. A Blobs store of already-alerted task IDs keeps it from
  repeating.
- `netlify/functions/weekly-leaderboard.js` — scheduled function (runs hourly,
  only sends Friday 8 AM Pacific) that ranks agents by how many leads they
  moved to Appointment Set / Under Contract during the current week, with a
  FUB link to each lead underneath the agent's count for easy tracking, using
  the log from `stage-webhook.js`.
- `netlify/functions/vtk-stage-webhook.js` — receives FUB's `peopleStageUpdated`
  webhook (registered separately from `stage-webhook.js`). Fires a Slack alert
  to a dedicated channel (`SLACK_WEBHOOK_VTK_URL`) when a lead whose `source`
  is exactly "VENDE TU KASA" reaches Listing agreement, Active Listing, Under
  Contract, Showing Homes, or Submitting Offers — so leadership can watch that
  source without wading through the account-wide feed.

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
   - `SLACK_WEBHOOK_VTK_URL` — Incoming Webhook URL for the channel where
     `vtk-stage-webhook.js` should post (separate from `SLACK_WEBHOOK_URL`,
     which is used by every other function in this repo).
   - `SLACK_WEBHOOK_ZILLOW_LA_URL`, `SLACK_WEBHOOK_ZILLOW_OC_URL`,
     `SLACK_WEBHOOK_ZILLOW_RV_URL` — Incoming Webhook URLs for the LA/OC/
     Riverside channels `stage-webhook.js` posts to (Zillow milestones, plus
     Riverside's Appointment Set alert).
4. **Trigger a redeploy** so the env vars take effect.
5. Send me the resulting site URL (`https://<your-site>.netlify.app`) — I'll
   test both endpoints and then register the webhook with FUB via its API.
