// api/report.js
// GET /api/report?date=YYYY-MM-DD&offset=0&limit=200
// Returns ONE batch of the day's lead activity, live from Smartlead.
// The Daily report page calls this repeatedly (offset += received) until hasMore is false,
// so no single request comes near Vercel's time limit.

import { fetchReportChunk, todayIST, addDays } from "../lib/report.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store"); // always live
  const apiKey = process.env.SMARTLEAD_API_KEY;
  const today = todayIST();
  const date = String(req.query?.date || addDays(today, -1));
  const offset = Math.max(0, parseInt(req.query?.offset, 10) || 0);
  const limit = Math.min(500, Math.max(10, parseInt(req.query?.limit, 10) || 200));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
    res.status(400).json({ error: "Pick a date in YYYY-MM-DD format that isn't in the future." });
    return;
  }
  if (!apiKey) {
    res.status(500).json({ error: "SMARTLEAD_API_KEY is not set in Vercel → Settings → Environment Variables." });
    return;
  }

  try {
    const chunk = await fetchReportChunk(apiKey, date, { offset, limit, timeoutMs: 50000 });
    res.status(200).json(chunk);
  } catch (err) {
    if (err.code === "RATE_LIMIT") return res.status(429).json({ code: "RATE_LIMIT", error: err.message });
    if (err.code === "TIMEOUT") return res.status(504).json({ code: "TIMEOUT", error: "Smartlead took too long to respond." });
    res.status(502).json({ error: err.message });
  }
}
