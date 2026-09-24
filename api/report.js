// api/report.js
// GET /api/report?date=YYYY-MM-DD  (defaults to yesterday, India time)
// Lists leads who opened, clicked or replied that day, with the email they were sent.

import { fetchLeadActivities } from "../lib/smartlead.js";

const TZ_OFFSET = "+05:30"; // IST (no daylight saving)
const TIME_ZONE = "Asia/Kolkata";

const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
function addDays(date, n) {
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

export default async function handler(req, res) {
  const apiKey = process.env.SMARTLEAD_API_KEY;
  const today = todayIST();
  const date = String(req.query?.date || addDays(today, -1));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({ error: "Pick a date in YYYY-MM-DD format that isn't in the future." });
    return;
  }
  if (!apiKey) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: "SMARTLEAD_API_KEY is not set in Vercel → Settings → Environment Variables." });
    return;
  }

  const from = new Date(`${date}T00:00:00.000${TZ_OFFSET}`);
  const to = new Date(`${date}T23:59:59.999${TZ_OFFSET}`);
  const inDay = (t) => {
    if (!t) return false;
    const d = new Date(t);
    return d >= from && d <= to;
  };

  try {
    const { leads, truncated } = await fetchLeadActivities(apiKey, from.toISOString(), to.toISOString());

    const opened = [];
    const clicked = [];
    const replied = [];
    let sentInDay = 0;

    for (const lead of leads) {
      const acts = [...(lead.activities || [])].sort((a, b) => new Date(a.sent_time) - new Date(b.sent_time));
      sentInDay += acts.filter((a) => inDay(a.sent_time)).length;

      // Opens/clicks have no timestamp in Smartlead's API, so we look at emails sent that day,
      // emails replied to that day, and the latest email the lead had received by the end of the day.
      const latest = [...acts].reverse().find((a) => a.sent_time && new Date(a.sent_time) <= to);

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

    // Past days change little (late opens), so cache them longer than today.
    res.setHeader("Cache-Control", date === today
      ? "public, s-maxage=120, stale-while-revalidate=600"
      : "public, s-maxage=900, stale-while-revalidate=3600");
    res.status(200).json({
      date,
      from: from.toISOString(),
      to: to.toISOString(),
      generated_at: new Date().toISOString(),
      truncated,
      counts: {
        leads_with_activity: leads.length,
        sent_in_day: sentInDay,
        opened: new Set(opened.map((r) => r.lead_id)).size,
        clicked: new Set(clicked.map((r) => r.lead_id)).size,
        replied: new Set(replied.map((r) => r.lead_id)).size,
      },
      replied,
      clicked,
      opened,
    });
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: err.message });
  }
}
