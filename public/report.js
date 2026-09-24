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

  async function dayTotals(date) {
    const hist = await getJson(`/data/history.json?t=${Date.now()}`).catch(() => ({ snapshots: [] }));
    const snaps = Object.fromEntries((hist.snapshots || []).map((s) => [s.date, s]));
    const start = snaps[date];
    let end = snaps[addDays(date, 1)];
    let meta = [];

    if (!end && addDays(date, 1) >= today()) {
      // Today, or yesterday before tonight's snapshot: use live numbers as the end of the day.
      const live = await getJson("/api/stats").catch(() => null);
      if (live) {
        end = { campaigns: Object.fromEntries(live.campaigns.map((c) => [String(c.id), c])) };
        meta = live.campaigns;
      }
    }
    if (!end) return null;
    if (!meta.length) meta = (await getJson(`/data/latest.json?t=${Date.now()}`).catch(() => ({ campaigns: [] }))).campaigns || [];

    const created = Object.fromEntries(meta.map((c) => [String(c.id), c.created_at ? istDate(new Date(c.created_at)) : null]));
    const totals = Object.fromEntries(METRICS.map((m) => [m, 0]));
    let skipped = 0;
    for (const [id, c] of Object.entries(end.campaigns)) {
      let base = start?.campaigns?.[id];
      if (!base) {
        const cd = created[id];
        if (cd && cd < date) { skipped++; continue; } // existed before our history; can't split by day
        base = null; // new that day
      }
      for (const m of METRICS) totals[m] += Math.max(0, (c[m] || 0) - (base ? base[m] || 0 : 0));
    }
    return { totals, skipped, isToday: date === today() };
  }

  // ---------- Loading ----------

  async function load(date) {
    const id = ++requestId;
    $("day").value = date;
    $("next-day").disabled = date >= today();
    history.replaceState(null, "", `?date=${date}`);
    $("report-title").textContent = date === today() ? "Today so far" : date === addDays(today(), -1) ? "Yesterday" : "Daily report";
    setStatus("loading", `Loading ${longDate(date)}…`);
    $("notice").hidden = true;
    for (const k of ["replied", "clicked", "opened"]) { $(`${k}-list`).innerHTML = `<p class="empty">Loading…</p>`; $(`${k}-count`).textContent = ""; }

    const [rep, sum] = await Promise.allSettled([getJson(`/api/report?date=${date}`), dayTotals(date)]);
    if (id !== requestId) return; // a newer date was picked meanwhile

    renderSummary(sum.status === "fulfilled" ? sum.value : null, rep.status === "fulfilled" ? rep.value : null, date);

    if (rep.status === "rejected") {
      report = null;
      setStatus("error", longDate(date));
      showNotice(`Couldn't load the lead lists: ${rep.reason.message}`);
      for (const k of ["replied", "clicked", "opened"]) $(`${k}-list`).innerHTML = `<p class="empty">Not available.</p>`;
      return;
    }
    report = rep.value;
    setStatus("live", `${longDate(date)} · loaded ${new Date(report.generated_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`);
    if (report.truncated) showNotice("This day had more activity than one load can fetch, so the lists are incomplete.");
    renderList("replied", report.replied);
    renderList("clicked", report.clicked);
    renderList("opened", report.opened);
  }

  function showNotice(text) {
    $("notice").textContent = text;
    $("notice").hidden = false;
  }

  // ---------- Rendering ----------

  function renderSummary(sum, rep, date) {
    const t = sum?.totals;
    const pctOf = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "");
    const item = (label, value, sub = "") =>
      `<div><dt>${label}</dt><dd>${value == null ? "–" : fmt.format(value)}${sub ? `<small>${sub}</small>` : ""}</dd></div>`;

    if (t) {
      $("summary").innerHTML =
        item("Emails sent", t.sent, `${fmt.format(t.unique_sent)} leads`) +
        item("Opened", t.unique_opened, pctOf(t.unique_opened, t.unique_sent)) +
        item("Clicked", t.clicked) +
        item("Replied", t.replied, pctOf(t.replied, t.unique_sent)) +
        item("Bounced", t.bounced, pctOf(t.bounced, t.sent)) +
        item("Unsubscribed", t.unsubscribed);
      const notes = [];
      if (sum.isToday) notes.push("Today is still in progress; totals are live.");
      if (sum.skipped) notes.push(`${sum.skipped} campaign${sum.skipped > 1 ? "s" : ""} started before your history began and aren't in these totals.`);
      $("summary-note").textContent = notes.join(" ");
    } else {
      // No snapshots for this day: fall back to what the activity feed can count exactly.
      $("summary").innerHTML =
        item("Emails sent", rep?.counts?.sent_in_day) +
        item("Leads opened", rep?.counts?.opened) +
        item("Leads clicked", rep?.counts?.clicked) +
        item("Leads replied", rep?.counts?.replied);
      $("summary-note").textContent = `Full totals aren't available for ${longDate(date)} because it's before your daily history began. These counts come from lead activity.`;
    }
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
    const cols = ["type", "lead_email", "campaign_name", "seq", "subject", "sent_time", "opens", "clicks", "reply_time", "reply_text", "from_email"];
    const cell = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [
      ...report.replied.map((r) => ({ type: "replied", ...r })),
      ...report.clicked.map((r) => ({ type: "clicked", ...r })),
      ...report.opened.map((r) => ({ type: "opened", ...r })),
    ];
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `smartlead-report-${report.date}.csv`;
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
