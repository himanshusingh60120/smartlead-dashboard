// scripts/fetch-smartlead.mjs
// Nightly snapshot (GitHub Actions, just after midnight IST).
// Everything on the dashboard is fetched live; this only records each day's starting totals,
// which the daily chart and the opens/clicks/bounces per day are calculated from.
// The dashboard itself is live; these snapshots are only the baseline for
// the daily chart and the 7/30/90-day views.
//   public/data/history.json -> one snapshot per day = totals at the start of that day
//   public/data/latest.json  -> fallback copy used only if the live API is down
// Run manually: SMARTLEAD_API_KEY=xxx node scripts/fetch-smartlead.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fetchAllCampaignStats, METRICS } from "../lib/smartlead.js";

const API_KEY = process.env.SMARTLEAD_API_KEY;
const DATA_DIR = path.resolve("public/data");
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 400);
const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || "Asia/Kolkata";

if (!API_KEY) {
  console.error("Missing SMARTLEAD_API_KEY environment variable.");
  process.exit(1);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const { campaigns, failed } = await fetchAllCampaignStats(API_KEY, {
    intervalMs: Number(process.env.REQUEST_DELAY_MS || 400),
    concurrency: 2,
    log: console.log,
  });

  const date = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date()); // YYYY-MM-DD
  await mkdir(DATA_DIR, { recursive: true });

  await writeFile(
    path.join(DATA_DIR, "latest.json"),
    JSON.stringify({ updated_at: new Date().toISOString(), date, time_zone: TIME_ZONE, campaigns, failed }, null, 2)
  );

  const history = await readJson(path.join(DATA_DIR, "history.json"), { snapshots: [] });
  history.snapshots = history.snapshots || [];

  // Keep the FIRST snapshot of each day: it marks the start of that day.
  // A manual run later in the day only refreshes latest.json.
  if (history.snapshots.some((s) => s.date === date)) {
    console.log(`Snapshot for ${date} already exists; left unchanged.`);
  } else {
    history.snapshots.push({
      date,
      taken_at: new Date().toISOString(),
      campaigns: Object.fromEntries(campaigns.map((c) => [c.id, Object.fromEntries(METRICS.map((m) => [m, c[m]]))])),
    });
    history.snapshots.sort((a, b) => a.date.localeCompare(b.date));
    history.snapshots = history.snapshots.slice(-HISTORY_DAYS);
    console.log(`Saved snapshot for ${date}.`);
  }

  await writeFile(path.join(DATA_DIR, "history.json"), JSON.stringify(history));
  console.log(`${campaigns.length} campaigns saved, ${failed.length} failed. History: ${history.snapshots.length} days.`);

}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
