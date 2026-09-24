// lib/smartlead.js
// Shared Smartlead API client, used by the live API (api/stats.js)
// and by the nightly snapshot script (scripts/fetch-smartlead.mjs).

const BASE = process.env.SMARTLEAD_BASE_URL || "https://server.smartlead.ai/api/v1";

export const METRICS = ["sent", "unique_sent", "unique_opened", "clicked", "replied", "bounced", "unsubscribed"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  const n = Number(v); // Smartlead returns most counts as strings
  return Number.isFinite(n) ? n : 0;
};

function createClient(apiKey, intervalMs) {
  // Spaces requests out so we stay under Smartlead's rate limit even when running in parallel.
  let nextSlot = 0;
  async function waitForSlot() {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + intervalMs;
    if (slot > now) await sleep(slot - now);
  }

  return async function api(pathname, { attempt = 1, rateLimitMessage = null } = {}) {
    await waitForSlot();
    const sep = pathname.includes("?") ? "&" : "?";
    const url = `${BASE}${pathname}${sep}api_key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 429 && rateLimitMessage) throw new Error(rateLimitMessage);
    if (res.status === 429 || res.status >= 500) {
      if (attempt > 4) throw new Error(`Smartlead returned ${res.status} on ${pathname.split("?")[0]} after 4 retries`);
      const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
      await sleep(retryAfter * 1000);
      return api(pathname, { attempt: attempt + 1, rateLimitMessage });
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("Smartlead rejected the API key. Check SMARTLEAD_API_KEY.");
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Smartlead returned ${res.status} on ${pathname.split("?")[0]}: ${body.slice(0, 200)}`);
    }
    return res.json();
  };
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

/**
 * Fetches every campaign and its lifetime analytics.
 * Returns { campaigns: [...], failed: [{ id, name, error }] }
 */
export async function fetchAllCampaignStats(apiKey, { intervalMs = 220, concurrency = 4, log = () => {} } = {}) {
  if (!apiKey) throw new Error("SMARTLEAD_API_KEY is not set.");
  const api = createClient(apiKey, intervalMs);

  const list = await api("/campaigns");
  const campaigns = Array.isArray(list) ? list : list.data || [];
  log(`Found ${campaigns.length} campaigns.`);

  const results = new Array(campaigns.length);
  const failed = [];
  let cursor = 0;

  async function worker() {
    while (cursor < campaigns.length) {
      const i = cursor++;
      const c = campaigns[i];
      try {
        const a = await api(`/campaigns/${c.id}/analytics`);
        results[i] = {
          id: c.id,
          name: c.name || a.name || `Campaign ${c.id}`,
          status: c.status || a.status || "UNKNOWN",
          created_at: c.created_at || a.created_at || null,
          client: a.client_name || null,
          plain_text: Boolean(a.send_as_plain_text),
          ...pickStats(a),
        };
        log(`  [${i + 1}/${campaigns.length}] ${c.name}`);
      } catch (err) {
        failed.push({ id: c.id, name: c.name, error: err.message });
        log(`  [${i + 1}/${campaigns.length}] ${c.name} failed: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, campaigns.length || 1) }, worker));

  const ok = results.filter(Boolean);
  if (campaigns.length > 0 && ok.length === 0) {
    throw new Error(`Every campaign request failed. First error: ${failed[0]?.error}`);
  }
  return { campaigns: ok, failed };
}

/**
 * Lead-level activity (emails sent, opens, clicks, replies) for leads with events
 * between fromIso and toIso. This endpoint allows only 10 requests per minute.
 * Returns { leads: [...], truncated: boolean }
 */
export async function fetchLeadActivities(apiKey, fromIso, toIso, { pageSize = 1000, maxPages = 5 } = {}) {
  if (!apiKey) throw new Error("SMARTLEAD_API_KEY is not set.");
  const api = createClient(apiKey, 0);
  const leads = [];
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const q = `/campaigns/all-leads-activities?limit=${pageSize}&offset=${page * pageSize}` +
      `&event_time_from=${encodeURIComponent(fromIso)}&event_time_to=${encodeURIComponent(toIso)}`;
    const r = await api(q, {
      rateLimitMessage: "Smartlead allows 10 report loads per minute. Wait a minute and try again.",
    });
    const rows = Array.isArray(r) ? r : r.data || [];
    leads.push(...rows);
    if (!r.hasMore || rows.length === 0) break;
    if (page === maxPages - 1) truncated = true;
  }
  return { leads, truncated };
}
