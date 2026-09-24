# Smartlead dashboard

A daily-updating dashboard of your Smartlead.ai email stats: emails sent, opens, clicks, replies, bounces and unsubscribes, per campaign and over time.

**How it works:** a GitHub Action runs every morning at 07:00 IST, pulls every campaign's stats from the Smartlead API, and commits them to `public/data/`. Vercel redeploys on each commit. No server or database; your API key never leaves GitHub Secrets.

```
GitHub Action (daily) ──> Smartlead API ──> public/data/*.json ──> git push ──> Vercel redeploys
```

## Setup (about 10 minutes)

1. **Get your Smartlead API key.** In Smartlead, open Settings and copy your API key.
2. **Create a private GitHub repo** and push this folder to it. Keep it private: the data files contain your campaign names and numbers.
3. **Add the key as a secret.** In the repo: Settings → Secrets and variables → Actions → New repository secret. Name `SMARTLEAD_API_KEY`, value is your key.
4. **Allow the Action to push.** Settings → Actions → General → Workflow permissions → select "Read and write permissions" → Save.
5. **Run the first sync.** Actions tab → "Daily Smartlead sync" → Run workflow. It takes about 1 second per campaign.
6. **Deploy on Vercel.** New Project → import the repo → Framework preset "Other" → Deploy. No build settings needed; `vercel.json` handles it.
7. **Restrict access (recommended).** In Vercel: Project → Settings → Deployment Protection. Options available depend on your Vercel plan.

## What you'll see

- **All time** totals are available right after the first sync.
- **Daily trend chart and 7/30/90-day views** start working after the second daily sync. Each day's numbers are the change between two consecutive snapshots, so history builds up from the day you start.

## Local preview

```bash
npm run demo   # writes sample data into public/data/
npm run dev    # serves on http://localhost:3000
```

Restore the real data before committing (`git checkout public/data`), or run a real sync locally:

```bash
SMARTLEAD_API_KEY=your_key npm run sync
```

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Sync time | `cron` in `.github/workflows/daily-sync.yml` (UTC) | `30 1 * * *` (07:00 IST) |
| Time zone for daily snapshots | `DASHBOARD_TIME_ZONE` in the workflow | `Asia/Kolkata` |
| Delay between API calls | `REQUEST_DELAY_MS` env var | `1100` ms |
| Days of history kept | `HISTORY_DAYS` env var | `400` |

## Metric definitions

- **Sent**: total emails sent (`sent_count`).
- **Opened**: unique leads who opened (`unique_open_count`). Open rate = unique opens ÷ unique leads sent.
- **Clicks**: total link clicks (`click_count`).
- **Replies**: `reply_count`. Reply rate = replies ÷ unique leads sent.
- **Bounced**: `bounce_count`. Bounce rate = bounces ÷ emails sent.
- Plain-text campaigns don't track opens or clicks; they show "–".

## Troubleshooting

- **Action fails with 401/403**: the `SMARTLEAD_API_KEY` secret is missing or wrong.
- **Action fails on `git push`**: step 4 (write permissions) wasn't saved.
- **429 errors in the log**: the script retries automatically; if it keeps happening, raise `REQUEST_DELAY_MS`.
- **Dashboard shows "Not synced yet"**: run the workflow manually once (step 5).
