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

  /**
   * options:
   *   rateLimitMessage  throw this instead of retrying on 429
   *   waitOn429Ms       on 429, wait this long and retry (for endpoints without Retry-After)
   *   timeoutMs         give up on a single request after this long
   *   retry             retry 5xx errors (default true)
   */
  return async function api(pathname, opts = {}) {
    const { attempt = 1, rateLimitMessage = null, waitOn429Ms = 0, timeoutMs = 0, retry = true } = opts;
    await waitForSlot();
    const sep = pathname.includes("?") ? "&" : "?";
    const url = `${BASE}${pathname}${sep}api_key=${encodeURIComponent(apiKey)}`;
    const where = pathname.split("?")[0];

    let res;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json" },
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        const e = new Error("Smartlead took too long to respond.");
        e.code = "TIMEOUT";
        throw e;
      }
      if (retry && attempt <= 3) {
        await sleep(2 ** attempt * 1000);
        return api(pathname, { ...opts, attempt: attempt + 1 });
      }
      throw new Error(`Couldn't reach Smartlead (${err.message}).`);
    }

    if (res.status === 429) {
      if (rateLimitMessage) {
        const e = new Error(rateLimitMessage);
        e.code = "RATE_LIMIT";
        throw e;
      }
      if (attempt > 5) throw new Error(`Smartlead kept rate-limiting ${where}.`);
      const wait = waitOn429Ms || (Number(res.headers.get("retry-after")) || 2 ** attempt) * 1000;
      await sleep(wait);
      return api(pathname, { ...opts, attempt: attempt + 1 });
    }
    if (res.status >= 500) {
      if (!retry || attempt > 4) throw new Error(`Smartlead returned ${res.status} on ${where}.`);
      await sleep(2 ** attempt * 1000);
      return api(pathname, { ...opts, attempt: attempt + 1 });
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("Smartlead rejected the API key. Check SMARTLEAD_API_KEY.");
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Smartlead returned ${res.status} on ${where}: ${body.slice(0, 200)}`);
    }
    return res.json();
  };
}

function pickStats(a) {
  const leads = a.campaign_lead_stats || {};
  const pick = (...keys) => {
    for (const k of keys) if (leads[k] != null) return num(leads[k]);
    return null;
  };
  const total = num(leads.total ?? a.total_count);
  const inProgress = pick("inprogress", "in_progress", "inProgress");
  const completed = pick("completed");
  const blocked = pick("blocked");
  let notStarted = pick("notStarted", "not_started", "yetToStart", "yet_to_start");
  if (notStarted == null && inProgress != null && completed != null) {
    notStarted = Math.max(0, total - inProgress - completed - (blocked || 0));
  }
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
    leads_total: total, // all leads uploaded to the campaign (Smartlead's "Unique Leads")
    leads_not_started: notStarted, // "Yet to Start"
    leads_in_progress: inProgress,
    leads_completed: completed,
    leads_blocked: blocked,
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
 * One page of lead-level activity (emails sent, opens, clicks, replies) for leads with
 * events between fromIso and toIso. Smartlead allows only 10 requests per minute here,
 * so a 429 is reported (code RATE_LIMIT) for the caller to wait out.
 * Returns { leads: [...], hasMore: true | false | null }  (null = Smartlead didn't say)
 */
export async function fetchActivitiesPage(apiKey, fromIso, toIso, { offset = 0, limit = 200, timeoutMs = 50000 } = {}) {
  if (!apiKey) throw new Error("SMARTLEAD_API_KEY is not set.");
  const api = createClient(apiKey, 0);
  const q = `/campaigns/all-leads-activities?limit=${limit}&offset=${offset}` +
    `&event_time_from=${encodeURIComponent(fromIso)}&event_time_to=${encodeURIComponent(toIso)}`;
  const r = await api(q, {
    rateLimitMessage: "Smartlead allows 10 of these requests per minute.",
    timeoutMs,
    retry: false,
  });
  const leads = Array.isArray(r) ? r : r.data || [];
  // Smartlead's hasMore isn't always reliable, so pass it through as-is and let the caller decide.
  const hasMore = typeof r?.hasMore === "boolean" ? r.hasMore : null;
  return { leads, hasMore };
}
