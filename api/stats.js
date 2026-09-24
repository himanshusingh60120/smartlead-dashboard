// api/stats.js
// Live endpoint: GET /api/stats returns current stats for every Smartlead campaign.
// Needs SMARTLEAD_API_KEY set in Vercel → Project → Settings → Environment Variables.

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
    // Vercel's edge cache keeps the answer for 60s, so many viewers don't each hit Smartlead.
    // The Refresh button adds ?fresh=… to skip the cache.
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
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
