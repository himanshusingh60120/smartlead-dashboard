// lib/report.js
// Report for a window of IST days (one day or a range): who opened, clicked or replied,
// the email we sent, and what kind of reply came back.
// Fetched live, one batch of leads at a time (see api/report.js).

import { fetchActivitiesPage } from "./smartlead.js";
import { classifyReply } from "./reply-categories.js";

const TZ_OFFSET = "+05:30"; // IST (no daylight saving)
const TIME_ZONE = "Asia/Kolkata";
export const MAX_RANGE_DAYS = 93; // longest window the report accepts (about 3 months)

export const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Days in a window, both ends included ("2026-10-01" to "2026-10-07" is 7). */
export function daysBetween(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000) + 1;
}

function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/(div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Keep only the new part of a reply, dropping the quoted earlier thread.
function replyOnly(text) {
  const cut = text.search(/\n\s*(On .{5,200}wrote:|-{2,}\s*Original Message|From:\s.+\nSent:)/i);
  const out = cut > 0 ? text.slice(0, cut) : text;
  return out.trim().slice(0, 4000);
}

function linksFrom(details) {
  if (!details || typeof details !== "object") return [];
  if (Array.isArray(details)) return details.map((d) => d?.url || d?.link || String(d)).filter(Boolean);
  return Object.keys(details).filter((k) => /^https?:/i.test(k));
}

const replyTime = (r) => r?.time || r?.reply_time || r?.created_at || null;

/**
 * Midnight IST at the start of fromDate to midnight IST after toDate.
 * Always whole days, so never shorter than 24h (Smartlead rejects shorter ranges).
 */
export function rangeWindow(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00.000${TZ_OFFSET}`);
  const last = new Date(`${toDate}T00:00:00.000${TZ_OFFSET}`);
  const to = new Date(last.getTime() + 24 * 60 * 60 * 1000);
  return { from, to };
}

/** One IST day. */
export const dayWindow = (date) => rangeWindow(date, date);

// Smartlead's lead category (its AI tag or one your team set), if this endpoint includes it.
function smartleadCategoryOf(lead, a, r) {
  const v = r?.lead_category ?? r?.category ?? a?.lead_category ?? lead?.lead_category ??
    lead?.lead_category_name ?? lead?.category ?? null;
  if (v == null) return null;
  if (typeof v === "object") return v.name || v.label || v.category_name || null;
  return String(v);
}

/** Fetches one batch of leads for the window and turns it into report rows. */
export async function fetchReportChunk(apiKey, fromDate, toDate = fromDate, opts = {}) {
  if (toDate && typeof toDate === "object") { opts = toDate; toDate = fromDate; } // old (apiKey, date, opts) calls
  const { offset = 0, limit = 200, timeoutMs = 50000 } = opts;
  const { from, to } = rangeWindow(fromDate, toDate);
  const { leads, hasMore } = await fetchActivitiesPage(apiKey, from.toISOString(), to.toISOString(), { offset, limit, timeoutMs });
  return {
    from_date: fromDate,
    to_date: toDate,
    from: from.toISOString(),
    to: to.toISOString(),
    offset,
    received: leads.length,
    hasMore,
    ...processLeads(leads, from, to),
  };
}

export function processLeads(leads, from, to) {
  const inWindow = (t) => {
    if (!t) return false;
    const d = new Date(t);
    return d >= from && d < to;
  };

  const opened = [];
  const clicked = [];
  const replied = [];
  let sentInWindow = 0;
  let repliesInWindow = 0;
  const leadsSent = new Set();
  const touchedByStep = {}; // "1" -> Set of unique emails that got E1 in the window, "2" -> E2, ...
  const repliesByStep = {}; // "1" -> replies received in the window to E1, ...

  for (const lead of leads) {
    const acts = [...(lead.activities || [])].sort((a, b) => new Date(a.sent_time) - new Date(b.sent_time));
    const sentHere = acts.filter((a) => inWindow(a.sent_time)).length;
    sentInWindow += sentHere;
    if (sentHere) leadsSent.add(lead.lead_id);

    for (const a of acts) {
      if (!inWindow(a.sent_time)) continue;
      const step = String(Number(a.email_seq_number) || "?");
      const who = String(a.to_email || lead.lead_email || lead.lead_id).trim().toLowerCase();
      (touchedByStep[step] ||= new Set()).add(who);
    }

    // Opens/clicks have no timestamp in Smartlead's API, so we look at emails sent in the window,
    // emails replied to in the window, and the latest email the lead had received by the end of it.
    const latest = [...acts].reverse().find((a) => a.sent_time && new Date(a.sent_time) < to);

    for (const a of acts) {
      const threadReplies = Array.isArray(a.thread_replies) ? a.thread_replies : [];
      const windowReplies = [
        ...(a.reply_details && inWindow(a.reply_details.time) ? [a.reply_details] : []),
        ...threadReplies.filter((r) => inWindow(replyTime(r))),
      ];
      const relevant = inWindow(a.sent_time) || windowReplies.length > 0 || a === latest;
      if (!relevant) continue;

      const row = {
        lead_id: lead.lead_id,
        lead_email: a.to_email || null,
        lead_status: lead.status || null,
        campaign_id: lead.campaign_id,
        campaign_name: lead.campaign_name,
        seq: a.email_seq_number ?? null,
        subject: a.subject || "",
        body: htmlToText(a.email_body).slice(0, 8000),
        sent_time: a.sent_time || null,
        sent_in_window: inWindow(a.sent_time),
        from_email: a.from_email || null,
        opens: Number(a.open_count) || 0,
        clicks: Number(a.click_count) || 0,
        links: linksFrom(a.click_details),
        reply_time: null,
        reply_text: null,
      };

      repliesInWindow += windowReplies.length;
      if (windowReplies.length) {
        const step = String(Number(a.email_seq_number) || "?");
        repliesByStep[step] = (repliesByStep[step] || 0) + windowReplies.length;

        // Latest reply in the window to this email
        const r = windowReplies.reduce((best, x) => (new Date(replyTime(x)) > new Date(replyTime(best)) ? x : best));
        const replyText = replyOnly(htmlToText(r.reply_email_body || r.email_body || r.body || ""));
        const cat = classifyReply({
          text: replyText,
          subject: r.subject || r.email_subject || "",
          sentBody: row.body,
          smartleadCategory: smartleadCategoryOf(lead, a, r),
        });
        replied.push({
          ...row,
          reply_time: replyTime(r),
          reply_text: replyText,
          reply_category: cat.key,
          reply_category_label: cat.label,
          reply_group: cat.group,
          reply_category_source: cat.source,
        });
      }
      if (row.clicks > 0) clicked.push(row);
      if (row.opens > 0) opened.push(row);
    }
  }

  return {
    counts: {
      leads_with_activity: leads.length,
      sent_in_window: sentInWindow,
      leads_sent_in_window: leadsSent.size,
      replies_in_window: repliesInWindow,
      // Unique emails touched per sequence step in the window: { "1": 120, "2": 80, ... }
      touched_by_step: Object.fromEntries(Object.entries(touchedByStep).map(([k, v]) => [k, v.size])),
      // Replies received in the window, by the step they replied to: { "1": 3, "2": 5, ... }
      replies_by_step: repliesByStep,
    },
    replied,
    clicked,
    opened,
  };
}
