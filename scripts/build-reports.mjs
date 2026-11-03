// scripts/build-reports.mjs
// Saves each finished IST day's lead activity (who opened, clicked, replied) to
// public/data/reports/YYYY-MM-DD.json, plus public/data/reports/index.json listing the saved days,
// so the Report page shows past days instantly instead of fetching them from Smartlead.
//
// These files contain lead email addresses and reply text. It only runs when SAVE_REPORTS=true
// (a repository variable): turn that on only once the GitHub repo is private.
//
// Run manually: SMARTLEAD_API_KEY=xxx SAVE_REPORTS=true node scripts/build-reports.mjs

import { writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fetchReportChunk, todayIST, addDays } from "../lib/report.js";

const API_KEY = process.env.SMARTLEAD_API_KEY;
const DIR = path.resolve("public/data/reports");
const BACKFILL_DAYS = Number(process.env.REPORT_BACKFILL_DAYS || 7); // also fill gaps in the 7 days before yesterday
const KEEP_DAYS = Number(process.env.REPORT_KEEP_DAYS || 100); // older files are deleted
const TIME_BUDGET_MS = Number(process.env.REPORT_TIME_BUDGET_MS || 20 * 60 * 1000); // stay inside the 30-min job limit
const GAP_MS = 6500; // Smartlead allows 10 of these requests a minute
const BODY_CHARS = 1500; // shorter sent-email bodies keep the files small

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.SAVE_REPORTS !== "true") {
  console.log('SAVE_REPORTS is not "true", so no reports are saved. Set the repository variable once the repo is private.');
  process.exit(0);
}
if (!API_KEY) {
  console.error("Missing SMARTLEAD_API_KEY environment variable.");
  process.exit(1);
}

let lastRequest = 0;
async function paced(fn) {
  const wait = lastRequest + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  return fn();
}

async function buildDay(date) {
  const counts = { leads_with_activity: 0, sent_in_window: 0, replies_in_window: 0, replies_by_step: {} };
  const sentLeads = new Set();
  const touched = {};
  const replied = [];
  const clicked = [];
  const opened = [];

  let offset = 0;
  let limit = 1000;
  let checkedEnd = false;
  let failures = 0;

  for (;;) {
    let chunk;
    try {
      chunk = await paced(() => fetchReportChunk(API_KEY, date, date, { offset, limit, timeoutMs: 120000 }));
      failures = 0;
    } catch (err) {
      if (err.code === "RATE_LIMIT") { console.log("  rate limit hit, waiting 61s"); await sleep(61000); continue; }
      if (limit > 100) { limit = Math.floor(limit / 2); console.log(`  slow response, trying batches of ${limit}`); continue; }
      if (++failures <= 3) { await sleep(5000 * failures); continue; }
      throw err;
    }

    const c = chunk.counts || {};
    counts.leads_with_activity += c.leads_with_activity || 0;
    counts.sent_in_window += c.sent_in_window || 0;
    counts.replies_in_window += c.replies_in_window || 0;
    for (const [s, n] of Object.entries(c.replies_by_step || {})) counts.replies_by_step[s] = (counts.replies_by_step[s] || 0) + n;
    for (const id of chunk.sent_leads || []) sentLeads.add(id);
    for (const [s, list] of Object.entries(chunk.touched_emails_by_step || {})) {
      const set = (touched[s] ||= new Set());
      for (const e of list) set.add(e);
    }
    replied.push(...chunk.replied);
    clicked.push(...chunk.clicked);
    opened.push(...chunk.opened);
    offset += chunk.received;

    if (chunk.received === 0) break;
    if (chunk.received < limit) {
      // A short page is normally the last one. Stop if Smartlead agrees; if it didn't say, check once.
      if (chunk.hasMore === false || checkedEnd) break;
      if (chunk.hasMore == null) checkedEnd = true;
    }
  }

  const trim = (rows) => rows.map((r) => ({ ...r, body: (r.body || "").slice(0, BODY_CHARS) }));
  return {
    date,
    from_date: date,
    to_date: date,
    generated_at: new Date().toISOString(),
    counts: {
      ...counts,
      leads_sent_in_window: sentLeads.size,
      touched_by_step: Object.fromEntries(Object.entries(touched).map(([k, v]) => [k, v.size])),
    },
    sent_leads: [...sentLeads],
    touched_emails_by_step: Object.fromEntries(Object.entries(touched).map(([k, v]) => [k, [...v]])),
    replied: trim(replied),
    clicked: trim(clicked),
    opened: trim(opened),
  };
}

async function main() {
  const started = Date.now();
  await mkdir(DIR, { recursive: true });
  const existing = new Set(
    (await readdir(DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10))
  );

  // Yesterday first, then any missing days before it. Today is never saved: it isn't finished.
  const yesterday = addDays(todayIST(), -1);
  const wanted = [];
  for (let i = 0; i <= BACKFILL_DAYS; i++) {
    const d = addDays(yesterday, -i);
    if (!existing.has(d)) wanted.push(d);
  }

  for (const date of wanted) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      console.log("Time budget used up; the remaining days will be filled in on the next run.");
      break;
    }
    try {
      console.log(`Building report for ${date}…`);
      const rep = await buildDay(date);
      await writeFile(path.join(DIR, `${date}.json`), JSON.stringify(rep));
      existing.add(date);
      console.log(`  saved: ${rep.counts.sent_in_window} sent, ${rep.counts.replies_in_window} replies.`);
    } catch (err) {
      console.error(`  couldn't build ${date}: ${err.message}`);
    }
  }

  // Drop old files and rewrite the index the Report page reads
  const cutoff = addDays(todayIST(), -KEEP_DAYS);
  for (const d of [...existing]) {
    if (d < cutoff) {
      await unlink(path.join(DIR, `${d}.json`)).catch(() => {});
      existing.delete(d);
    }
  }
  const dates = [...existing].sort();
  await writeFile(path.join(DIR, "index.json"), JSON.stringify({ updated_at: new Date().toISOString(), dates }));
  console.log(`${dates.length} saved days in total.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
