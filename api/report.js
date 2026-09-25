// api/report.js
// GET /api/report?date=YYYY-MM-DD  (defaults to yesterday, India time)
// Live version of the daily report. Finished days are also saved nightly to
// public/data/reports/, which the page loads first, so this is mainly used for today.

import { buildReport, todayIST, addDays } from "../lib/report.js";

const TIME_BUDGET_MS = 45000; // stay well inside Vercel's 60s function limit

export default async function handler(req, res) {
  const started = Date.now();
  const apiKey = process.env.SMARTLEAD_API_KEY;
  const today = todayIST();
  const date = String(req.query?.date || addDays(today, -1));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({ error: "Pick a date in YYYY-MM-DD format that isn't in the future." });
    return;
  }
  if (!apiKey) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: "SMARTLEAD_API_KEY is not set in Vercel → Settings → Environment Variables." });
    return;
  }

  try {
    const report = await buildReport(apiKey, date, { mode: "live", deadline: started + TIME_BUDGET_MS });
    report.source = "live";
    // Cache complete reports; partial ones only briefly so a retry can get more.
    res.setHeader("Cache-Control", report.truncated
      ? "public, s-maxage=60"
      : date === today
        ? "public, s-maxage=120, stale-while-revalidate=600"
        : "public, s-maxage=900, stale-while-revalidate=3600");
    res.status(200).json(report);
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    const slow = err.code === "TIMEOUT";
    res.status(slow ? 504 : 502).json({
      error: slow ? "Smartlead is responding slowly right now. Try again in a minute." : err.message,
    });
  }
}
