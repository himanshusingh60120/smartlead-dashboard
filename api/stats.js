// api/stats.js
// Live endpoint: GET /api/stats returns current stats for every Smartlead campaign.
// Needs SMARTLEAD_API_KEY set in Vercel → Project → Settings → Environment Variables.
// Successful responses are kept by Vercel's CDN for 2 minutes (and served stale for up to
// 10 more while a fresh copy loads), so reloads, auto-refresh and several viewers share one
// round of Smartlead calls. Add any unique query (the Refresh button sends ?fresh=…) to skip it.

import { fetchAllCampaignStats } from "../lib/smartlead.js";

export default async function handler(req, res) {
  const apiKey = process.env.SMARTLEAD_API_KEY;
  if (!apiKey) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: "SMARTLEAD_API_KEY is not set in Vercel → Settings → Environment Variables." });
    return;
  }

  try {
    const { campaigns, failed } = await fetchAllCampaignStats(apiKey);
    // Don't keep a result with missing campaigns: the next load should try again.
    res.setHeader(
      "Cache-Control",
      failed.length ? "no-store" : "public, s-maxage=120, stale-while-revalidate=600"
    );
    res.status(200).json({
      updated_at: new Date().toISOString(),
      live: true,
      campaigns,
      failed,
    });
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: err.message });
  }
}
