// Pulls lifetime analytics for every Smartlead campaign and stores:
//   public/data/latest.json   -> current totals per campaign
//   public/data/history.json  -> one snapshot per day (used for daily trends)
// Run: SMARTLEAD_API_KEY=xxx node scripts/fetch-smartlead.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const API_KEY = process.env.SMARTLEAD_API_KEY;
const BASE = "https://server.smartlead.ai/api/v1";
const DATA_DIR = path.resolve("public/data");
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 400);
// Smartlead rate limits vary by plan; ~1 request/second is safe for all of them.
const DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 1100);
const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || "Asia/Kolkata";

if (!API_KEY) {
  console.error("Missing SMARTLEAD_API_KEY environment variable.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  const n = Number(v); // Smartlead returns most counts as strings
  return Number.isFinite(n) ? n : 0;
};

async function api(pathname, attempt = 1) {
  const sep = pathname.includes("?") ? "&" : "?";
  const url = `${BASE}${pathname}${sep}api_key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 5) throw new Error(`${res.status} on ${pathname} after 5 retries`);
    const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
    console.warn(`  ${res.status} on ${pathname}, retrying in ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return api(pathname, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} on ${pathname}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function todayInZone() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date()); // YYYY-MM-DD
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function pickStats(a) {
  const leads = a.campaign_lead_stats || {};
  return {
    sent: num(a.sent_count),
    unique_sent: num(a.unique_sent_count),
    opened: num(a.open_count),
    unique_opened: num(a.unique_open_count),
    clicked: num(a.click_count),
    unique_clicked: num(a.unique_click_count),
    replied: num(a.reply_count),
    bounced: num(a.bounce_count),
    unsubscribed: num(a.unsubscribed_count),
    leads_total: num(leads.total ?? a.total_count),
    leads_interested: num(leads.interested),
  };
}

async function main() {
  console.log("Fetching campaign list…");
  const list = await api("/campaigns");
  const campaigns = Array.isArray(list) ? list : list.data || [];
  console.log(`Found ${campaigns.length} campaigns.`);

  const results = [];
  for (const [i, c] of campaigns.entries()) {
    await sleep(DELAY_MS);
    try {
      const a = await api(`/campaigns/${c.id}/analytics`);
      results.push({
        id: c.id,
        name: c.name || a.name || `Campaign ${c.id}`,
        status: c.status || a.status || "UNKNOWN",
        created_at: c.created_at || a.created_at || null,
        client: a.client_name || null,
        plain_text: Boolean(a.send_as_plain_text),
        ...pickStats(a),
      });
      console.log(`  [${i + 1}/${campaigns.length}] ${c.name}`);
    } catch (err) {
      console.error(`  [${i + 1}/${campaigns.length}] ${c.name} failed: ${err.message}`);
    }
  }

  if (campaigns.length > 0 && results.length === 0) {
    throw new Error("Every campaign request failed; keeping previous data.");
  }

  const date = todayInZone();
  await mkdir(DATA_DIR, { recursive: true });

  await writeFile(
    path.join(DATA_DIR, "latest.json"),
    JSON.stringify({ updated_at: new Date().toISOString(), date, time_zone: TIME_ZONE, campaigns: results }, null, 2)
  );

  // One snapshot per day; re-running on the same day replaces that day's snapshot.
  const history = await readJson(path.join(DATA_DIR, "history.json"), { snapshots: [] });
  const snapshot = {
    date,
    campaigns: Object.fromEntries(
      results.map((r) => [
        r.id,
        {
          sent: r.sent,
          unique_sent: r.unique_sent,
          unique_opened: r.unique_opened,
          clicked: r.clicked,
          replied: r.replied,
          bounced: r.bounced,
          unsubscribed: r.unsubscribed,
        },
      ])
    ),
  };
  history.snapshots = (history.snapshots || []).filter((s) => s.date !== date);
  history.snapshots.push(snapshot);
  history.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  history.snapshots = history.snapshots.slice(-HISTORY_DAYS);

  await writeFile(path.join(DATA_DIR, "history.json"), JSON.stringify(history));
  console.log(`Saved ${results.length} campaigns for ${date}. History: ${history.snapshots.length} days.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
