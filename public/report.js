// public/report.js
(() => {
  "use strict";

  const METRICS = ["sent", "unique_sent", "unique_opened", "clicked", "replied", "bounced", "unsubscribed"];
  const TIME_ZONE = "Asia/Kolkata";
  const PAGE = 50;

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const istDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(d);
  const today = () => istDate(new Date());
  const addDays = (date, n) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const timeIST = (t) => (t ? new Date(t).toLocaleString(undefined, { timeZone: TIME_ZONE, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "–");
  const longDate = (date) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  let report = null;
  let lastSummary = []; // [label, value, note] rows for the CSV
  let requestId = 0;

  async function getJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
    return body;
  }

  function setStatus(kind, text) {
    $("live-dot").dataset.state = kind;
    $("sync-status").textContent = text;
  }

  // ---------- Day totals from daily snapshots ----------
  // Used only for numbers Smartlead doesn't timestamp (opens, clicks, bounces, unsubscribes).
  // A day is only counted when it starts and ends on a snapshot taken around midnight IST.

  const hourIST = (t) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(new Date(t)));

  async function dayTotals(date) {
    const hist = await getJson(`/data/history.json?t=${Date.now()}`).catch(() => ({ snapshots: [] }));
    const list = [...(hist.snapshots || [])].sort((a, b) => a.date.localeCompare(b.date));
    const snaps = Object.fromEntries(list.map((s) => [s.date, s]));
    // Older snapshots have no taken_at: the very first one was a manual daytime run, the rest ran at midnight.
    const atMidnight = (snap) => Boolean(snap) && (snap.taken_at ? hourIST(snap.taken_at) < 4 : snap !== list[0]);

    const start = snaps[date];
    if (!atMidnight(start)) return null;

    let end = snaps[addDays(date, 1)];
    const isToday = date === today();
    if (end && !atMidnight(end)) return null;
    if (!end) {
      if (addDays(date, 1) < today()) return null; // a day is missing from history
      // Today, or yesterday before tonight's snapshot has run: use live numbers.
      const live = await getJson("/api/stats").catch(() => null);
      if (!live) return null;
      end = { campaigns: Object.fromEntries(live.campaigns.map((c) => [String(c.id), c])) };
      if (!isToday) return null; // yesterday without a midnight snapshot would include today's activity
    }

    const totals = Object.fromEntries(METRICS.map((m) => [m, 0]));
    for (const [id, c] of Object.entries(end.campaigns)) {
      const base = start.campaigns[id]; // missing = campaign created during the day
      for (const m of METRICS) totals[m] += Math.max(0, (c[m] || 0) - (base ? base[m] || 0 : 0));
    }
    return { totals, isToday };
  }

  // ---------- Loading ----------

  // Finished days: use the report saved by the nightly job (instant, complete).
  // Today, or days without a saved report: build it live from Smartlead.
  async function fetchReport(date, { live = false } = {}) {
    if (!live && date < today()) {
      try {
        return await getJson(`/data/reports/${date}.json?t=${Date.now()}`);
      } catch { /* not saved yet, fall through to live */ }
    }
    try {
      return await getJson(`/api/report?date=${date}${live ? `&fresh=${Date.now()}` : ""}`);
    } catch (err) {
      if (/\(50[24]\)/.test(err.message)) {
        throw new Error("Smartlead took too long to send this day's activity. Try again in a minute.");
      }
      throw err;
    }
  }

  async function load(date, opts = {}) {
    const id = ++requestId;
    $("day").value = date;
    $("next-day").disabled = date >= today();
    history.replaceState(null, "", `?date=${date}`);
    $("report-title").textContent = date === today() ? "Today so far" : date === addDays(today(), -1) ? "Yesterday" : "Daily report";
    setStatus("loading", `Loading ${longDate(date)}…`);
    $("notice").hidden = true;
    for (const k of ["replied", "clicked", "opened"]) { $(`${k}-list`).innerHTML = `<p class="empty">Loading…</p>`; $(`${k}-count`).textContent = ""; }

    const [rep, sum] = await Promise.allSettled([fetchReport(date, opts), dayTotals(date)]);
    if (id !== requestId) return; // a newer date was picked meanwhile

    renderSummary(sum.status === "fulfilled" ? sum.value : null, rep.status === "fulfilled" ? rep.value : null, date);

    if (rep.status === "rejected") {
      report = null;
      setStatus("error", longDate(date));
      showNotice(`Couldn't load the lead lists: ${rep.reason.message}`, { retry: true });
      for (const k of ["replied", "clicked", "opened"]) $(`${k}-list`).innerHTML = `<p class="empty">Not available.</p>`;
      return;
    }
    report = rep.value;
    const at = new Date(report.generated_at).toLocaleString(undefined, { timeZone: TIME_ZONE, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    setStatus("live", report.source === "nightly"
      ? `${longDate(date)} · saved ${at} IST`
      : `${longDate(date)} · live, loaded ${at} IST`);
    if (report.truncated) {
      showNotice("Smartlead was slow, so this shows the activity loaded so far and the lists may be incomplete. Try again in a minute for the rest.", { retry: true });
    } else if (report.source === "nightly") {
      showNotice("Saved by the nightly job, so opens that came in after it ran aren't included.", { retry: true, retryLabel: "Load live from Smartlead" });
    }
    renderList("replied", report.replied);
    renderList("clicked", report.clicked);
    renderList("opened", report.opened);
  }

  function showNotice(text, { retry = false, retryLabel = "Try again" } = {}) {
    const el = $("notice");
    el.textContent = text;
    if (retry) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "link-btn";
      btn.style.marginLeft = "0.5rem";
      btn.textContent = retryLabel;
      btn.addEventListener("click", () => load($("day").value, { live: true }));
      el.append(btn);
    }
    el.hidden = false;
  }

  // ---------- Rendering ----------

  function renderSummary(sum, rep, date) {
    const t = sum?.totals;
    const c = rep?.counts;
    const pctOf = (n, d) => (n != null && d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "");
    const item = (label, value, sub = "") =>
      `<div><dt>${label}</dt><dd>${value == null ? "–" : fmt.format(value)}${sub ? `<small>${sub}</small>` : ""}</dd></div>`;

    // Exact, from Smartlead's timestamps within the IST day
    const sent = c?.sent_in_day;
    const leads = c?.leads_sent_in_day;
    const replies = c?.replies_in_day ?? c?.replied;

    // Opens/clicks: midnight-to-midnight snapshots when available, otherwise leads in the lists below
    const opened = t ? t.unique_opened : c?.opened;
    const clicked = t ? t.clicked : c?.clicked;

    lastSummary = [
      ["Emails sent", sent, "exact, from send timestamps"],
      ["Leads contacted", leads, ""],
      [t ? "Opened (unique)" : "Leads opened", opened, t ? `open rate ${pctOf(opened, t.unique_sent) || "–"}` : "from lead activity"],
      [t ? "Clicks" : "Leads clicked", clicked, ""],
      ["Replies", replies, `reply rate ${pctOf(replies, leads) || "–"}`],
      ["Bounced", t ? t.bounced : null, t ? "" : "not available for this day"],
      ["Unsubscribed", t ? t.unsubscribed : null, t ? "" : "not available for this day"],
      ["Leads who opened", c?.opened, "listed below"],
      ["Leads who clicked", c?.clicked, "listed below"],
      ["Leads who replied", c?.replied, "listed below"],
    ];
    $("summary").innerHTML =
      item("Emails sent", sent, leads != null ? `${fmt.format(leads)} leads` : "") +
      item(t ? "Opened" : "Leads opened", opened, pctOf(opened, t ? t.unique_sent : leads)) +
      item(t ? "Clicked" : "Leads clicked", clicked) +
      item("Replies", replies, pctOf(replies, leads)) +
      item("Bounced", t ? t.bounced : null, t ? pctOf(t.bounced, t.sent) : "") +
      item("Unsubscribed", t ? t.unsubscribed : null);

    const notes = [`Counted from 12:00 AM to 12:00 AM India time${sum?.isToday || date === today() ? " (today is still in progress)" : ""}.`];
    if (!t) notes.push("Opens and clicks are counted from the lead lists below, and bounces aren't available, because this day doesn't have midnight snapshots at both ends.");
    $("summary-note").textContent = notes.join(" ");
  }

  function renderList(kind, rows) {
    $(`${kind}-count`).textContent = rows.length ? `(${fmt.format(new Set(rows.map((r) => r.lead_id)).size)})` : "";
    const el = $(`${kind}-list`);
    if (!rows.length) {
      el.innerHTML = `<p class="empty">${{ replied: "No replies this day.", clicked: "No clicks this day.", opened: "No opens this day." }[kind]}</p>`;
      return;
    }
    const draw = (n) => {
      el.innerHTML = rows.slice(0, n).map((r) => leadItem(kind, r)).join("") +
        (rows.length > n ? `<button type="button" class="ghost show-more">Show all ${fmt.format(rows.length)}</button>` : "");
      el.querySelector(".show-more")?.addEventListener("click", () => draw(rows.length));
    };
    draw(PAGE);
  }

  function leadItem(kind, r) {
    const chip =
      kind === "replied" ? `Replied ${timeIST(r.reply_time)}` :
      kind === "clicked" ? `${r.clicks} click${r.clicks === 1 ? "" : "s"}` :
      `${r.opens} open${r.opens === 1 ? "" : "s"}`;
    const links = r.links?.length
      ? `<div class="block"><h3>Links clicked</h3><ul>${r.links.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>` : "";
    const reply = r.reply_text != null
      ? `<div class="block reply"><h3>Their reply · ${esc(timeIST(r.reply_time))}</h3><div class="body">${esc(r.reply_text) || "<em>No text</em>"}</div></div>` : "";

    return `
      <details class="lead" data-kind="${kind}">
        <summary>
          <span class="who">
            <strong>${esc(r.lead_email || `Lead ${r.lead_id}`)}</strong>
            <span class="meta">${esc(r.campaign_name)}${r.seq != null ? `, step ${esc(r.seq)}` : ""}</span>
          </span>
          <span class="subject">${esc(r.subject) || "<em>No subject</em>"}</span>
          <span class="chip">${esc(chip)}</span>
        </summary>
        <div class="lead-body">
          ${reply}
          <div class="block">
            <h3>Email we sent</h3>
            <p class="meta">From ${esc(r.from_email || "–")} · sent ${esc(timeIST(r.sent_time))} · ${r.opens} open${r.opens === 1 ? "" : "s"}, ${r.clicks} click${r.clicks === 1 ? "" : "s"}</p>
            <p class="subject-line">${esc(r.subject)}</p>
            <div class="body">${esc(r.body) || "<em>No body text</em>"}</div>
          </div>
          ${links}
        </div>
      </details>`;
  }

  function exportCsv() {
    if (!report) return;
    const cell = (v) => {
      const str = v == null ? "" : String(v);
      return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const line = (arr) => arr.map(cell).join(",");
    const ist = (t) => (t ? new Date(t).toLocaleString("en-IN", { timeZone: TIME_ZONE, day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "");

    // One row per lead + email, with every signal on it
    const byKey = new Map();
    const add = (r) => {
      const key = `${r.lead_id}|${r.campaign_id}|${r.seq}|${r.sent_time}`;
      const row = byKey.get(key) || { ...r };
      if (r.reply_time) { row.reply_time = r.reply_time; row.reply_text = r.reply_text; }
      byKey.set(key, row);
    };
    [...report.replied, ...report.clicked, ...report.opened].forEach(add);
    const rows = [...byKey.values()].sort((a, b) =>
      (b.reply_time ? 1 : 0) - (a.reply_time ? 1 : 0) || b.clicks - a.clicks || b.opens - a.opens);

    const d = report.date;
    const out = [
      line(["Smartlead daily report"]),
      line(["Date", longDate(d)]),
      line(["Time window (IST)", `${ist(report.from)} to ${ist(report.to)}`]),
      line(["Exported at (IST)", ist(new Date().toISOString())]),
      "",
      line(["Metric", "Value", "Note"]),
      ...lastSummary.map(([label, value, note]) => line([label, value ?? "", note])),
      "",
      line([
        "Engagement", "Lead email", "Lead status", "Campaign", "Campaign ID", "Sequence step", "Subject",
        "Sent from", "Sent at (IST)", "Sent on this day", "Opened", "Opens", "Clicked", "Clicks", "Links clicked",
        "Replied", "Replied at (IST)", "Reply text", "Email we sent",
      ]),
      ...rows.map((r) => line([
        r.reply_time ? "Replied" : r.clicks > 0 ? "Clicked" : "Opened",
        r.lead_email, r.lead_status, r.campaign_name, r.campaign_id, r.seq, r.subject,
        r.from_email, ist(r.sent_time), r.sent_in_day ? "Yes" : "No",
        r.opens > 0 ? "Yes" : "No", r.opens, r.clicks > 0 ? "Yes" : "No", r.clicks, (r.links || []).join(" | "),
        r.reply_time ? "Yes" : "No", ist(r.reply_time), r.reply_text || "", r.body || "",
      ])),
    ];
    download(`smartlead-daily-report-${d}.csv`, out.join("\r\n"));
  }

  function download(name, text) {
    const a = document.createElement("a");
    // BOM so Excel opens it as UTF-8 (names, ₹, accents display correctly)
    a.href = URL.createObjectURL(new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Setup ----------

  const params = new URLSearchParams(location.search);
  const requested = params.get("date");
  const initial = /^\d{4}-\d{2}-\d{2}$/.test(requested || "") && requested <= today() ? requested : addDays(today(), -1);

  $("day").max = today();
  $("day").addEventListener("change", (e) => e.target.value && load(e.target.value > today() ? today() : e.target.value));
  $("prev-day").addEventListener("click", () => load(addDays($("day").value, -1)));
  $("next-day").addEventListener("click", () => load(addDays($("day").value, 1)));
  $("export-csv").addEventListener("click", exportCsv);

  load(initial);
})();
