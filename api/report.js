// api/report.js
// GET /api/report?from=YYYY-MM-DD&to=YYYY-MM-DD&offset=0&limit=200
// Returns ONE batch of lead activity for the window (IST days, both ends included), live from Smartlead.
// ?date=YYYY-MM-DD still works and means a one-day window.
// The Report page calls this repeatedly (offset += received) until a batch comes back empty,
// and splits long windows into pieces, so no single request comes near Vercel's time limit.
import { fetchReportChunk, todayIST, addDays, daysBetween, MAX_RANGE_DAYS } from "../lib/report.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store"); // always live
  const apiKey = process.env.SMARTLEAD_API_KEY;
  const today = todayIST();
  const q = req.query || {};
  const fromDate = String(q.from || q.date || addDays(today, -1));
  const toDate = String(q.to || q.date || fromDate);
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);
  const limit = Math.min(500, Math.max(10, parseInt(q.limit, 10) || 200));

  const bad = (error) => res.status(400).json({ error });
  if (!DATE.test(fromDate) || !DATE.test(toDate)) return bad("Dates must be in YYYY-MM-DD format.");
  if (toDate > today) return bad("The window can't end in the future.");
  if (fromDate > toDate) return bad("The start date must be on or before the end date.");
  if (daysBetween(fromDate, toDate) > MAX_RANGE_DAYS) return bad(`Pick a window of ${MAX_RANGE_DAYS} days or less.`);

  if (!apiKey) {
    res.status(500).json({ error: "SMARTLEAD_API_KEY is not set in Vercel → Settings → Environment Variables." });
    return;
  }

  try {
    const t0 = Date.now();
    const chunk = await fetchReportChunk(apiKey, fromDate, toDate, { offset, limit, timeoutMs: 50000 });
    chunk.smartlead_ms = Date.now() - t0; // lets the page tune its batch size
    res.status(200).json(chunk);
  } catch (err) {
    if (err.code === "RATE_LIMIT") return res.status(429).json({ code: "RATE_LIMIT", error: err.message });
    if (err.code === "TIMEOUT") return res.status(504).json({ code: "TIMEOUT", error: "Smartlead took too long to respond." });
    res.status(502).json({ error: err.message });
  }
}
