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
    // Never cache: every page load, reload and Refresh gets numbers straight from Smartlead.
    res.setHeader("Cache-Control", "no-store");
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
