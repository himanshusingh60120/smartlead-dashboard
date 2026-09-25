// scripts/fetch-smartlead.mjs
// Nightly job (GitHub Actions, just after midnight IST):
//   1. saves a snapshot of every campaign's totals
//   2. builds the daily report for yesterday (and any of the last 7 days that are missing)
//      into public/data/reports/YYYY-MM-DD.json, so the Daily report page loads instantly
// The dashboard itself is live; these snapshots are only the baseline for
// the daily chart and the 7/30/90-day views.
//   public/data/history.json -> one snapshot per day = totals at the start of that day
//   public/data/latest.json  -> fallback copy used only if the live API is down
// Run manually: SMARTLEAD_API_KEY=xxx node scripts/fetch-smartlead.mjs

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fetchAllCampaignStats, METRICS } from "../lib/smartlead.js";
import { buildReport, addDays } from "../lib/report.js";

const API_KEY = process.env.SMARTLEAD_API_KEY;
const DATA_DIR = path.resolve("public/data");
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 400);
const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || "Asia/Kolkata";
const REPORT_DIR = path.join(DATA_DIR, "reports");
const REPORT_DAYS_KEPT = Number(process.env.REPORT_DAYS_KEPT || 120);

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

  await saveReports(date);
}

async function saveReports(today) {
  await mkdir(REPORT_DIR, { recursive: true });
  const existing = new Set((await readdir(REPORT_DIR)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, 10)));

  // Always rebuild yesterday (it just finished); fill in any missing days from the past week.
  const dates = [];
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, -i);
    if (i === 1 || !existing.has(d)) dates.push(d);
  }

  for (const d of dates) {
    try {
      console.log(`Building daily report for ${d}…`);
      const report = await buildReport(API_KEY, d, { mode: "patient" });
      report.source = "nightly";
      await writeFile(path.join(REPORT_DIR, `${d}.json`), JSON.stringify(report));
      console.log(`  ${report.counts.sent_in_day} sent, ${report.counts.opened} opened, ${report.counts.replied} replied.`);
    } catch (err) {
      // A report failure shouldn't stop the snapshot from being saved.
      console.warn(`  Couldn't build report for ${d}: ${err.message}`);
    }
  }

  // Remove old reports
  const cutoff = addDays(today, -REPORT_DAYS_KEPT);
  for (const f of await readdir(REPORT_DIR)) {
    if (f.endsWith(".json") && f.slice(0, 10) < cutoff) await unlink(path.join(REPORT_DIR, f));
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
