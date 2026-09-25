// lib/report.js
// Builds the daily report for one IST day: who opened, clicked or replied, with the email we sent.
// Used live by api/report.js and nightly by scripts/fetch-smartlead.mjs.

import { fetchLeadActivities } from "./smartlead.js";

const TZ_OFFSET = "+05:30"; // IST (no daylight saving)
const TIME_ZONE = "Asia/Kolkata";

export const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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

/**
 * @param {string} date  YYYY-MM-DD (India time)
 * @param {object} fetchOpts  passed to fetchLeadActivities ({ mode, deadline })
 */
export async function buildReport(apiKey, date, fetchOpts = {}) {
  // Exactly 24 hours: midnight to the next midnight, India time.
  // (Smartlead rejects ranges shorter than one full day.)
  const from = new Date(`${date}T00:00:00.000${TZ_OFFSET}`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const inDay = (t) => {
    if (!t) return false;
    const d = new Date(t);
    return d >= from && d < to;
  };

  const { leads, truncated } = await fetchLeadActivities(apiKey, from.toISOString(), to.toISOString(), fetchOpts);

  const opened = [];
  const clicked = [];
  const replied = [];
  let sentInDay = 0;
  let repliesInDay = 0;
  const leadsSent = new Set();

  for (const lead of leads) {
    const acts = [...(lead.activities || [])].sort((a, b) => new Date(a.sent_time) - new Date(b.sent_time));
    const sentToday = acts.filter((a) => inDay(a.sent_time)).length;
    sentInDay += sentToday;
    if (sentToday) leadsSent.add(lead.lead_id);

    // Opens/clicks have no timestamp in Smartlead's API, so we look at emails sent that day,
    // emails replied to that day, and the latest email the lead had received by the end of the day.
    const latest = [...acts].reverse().find((a) => a.sent_time && new Date(a.sent_time) < to);

    for (const a of acts) {
      const threadReplies = Array.isArray(a.thread_replies) ? a.thread_replies : [];
      const dayReplies = [
        ...(a.reply_details && inDay(a.reply_details.time) ? [a.reply_details] : []),
        ...threadReplies.filter((r) => inDay(r?.time || r?.reply_time || r?.created_at)),
      ];
      const relevant = inDay(a.sent_time) || dayReplies.length > 0 || a === latest;
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
        sent_in_day: inDay(a.sent_time),
        from_email: a.from_email || null,
        opens: Number(a.open_count) || 0,
        clicks: Number(a.click_count) || 0,
        links: linksFrom(a.click_details),
        reply_time: null,
        reply_text: null,
      };

      repliesInDay += dayReplies.length;
      if (dayReplies.length) {
        const r = dayReplies[dayReplies.length - 1];
        replied.push({
          ...row,
          reply_time: r.time || r.reply_time || r.created_at || null,
          reply_text: replyOnly(htmlToText(r.reply_email_body || r.email_body || r.body || "")),
        });
      }
      if (row.clicks > 0) clicked.push(row);
      if (row.opens > 0) opened.push(row);
    }
  }


  replied.sort((a, b) => new Date(b.reply_time) - new Date(a.reply_time));
  clicked.sort((a, b) => b.clicks - a.clicks);
  opened.sort((a, b) => b.opens - a.opens);

  return {
    date,
    from: from.toISOString(),
    to: to.toISOString(),
    generated_at: new Date().toISOString(),
    truncated,
    counts: {
      leads_with_activity: leads.length,
      sent_in_day: sentInDay,
      leads_sent_in_day: leadsSent.size,
      replies_in_day: repliesInDay,
      opened: new Set(opened.map((r) => r.lead_id)).size,
      clicked: new Set(clicked.map((r) => r.lead_id)).size,
      replied: new Set(replied.map((r) => r.lead_id)).size,
    },
    replied,
    clicked,
    opened,
  };
}
