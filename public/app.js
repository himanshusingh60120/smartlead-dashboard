// public/app.js
(() => {
  "use strict";

  const METRICS = ["sent", "unique_sent", "unique_opened", "clicked", "replied", "bounced", "unsubscribed"];
  const AUTO_REFRESH_MS = 5 * 60 * 1000;

  const state = { range: "all", sortKey: "sent", sortDir: "desc", search: "", status: "" };
  let data = null;      // { updated_at, live, campaigns, error? }
  let snapshots = [];   // daily snapshots from history.json (totals at the start of each day)
  let deltas = [];      // [{ date, campaigns: { id: { metric: n } } }]
  let chart = null;
  let loading = false;
  let timer = null;

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat();
  const pct = (n, d) => (d > 0 ? n / d : null);
  const fmtPct = (v) => (v == null ? "–" : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const titleCase = (s) => String(s || "").toLowerCase().replace(/(^|\s|_)\w/g, (m) => m.toUpperCase()).replace(/_/g, " ");

  // ---------- Loading ----------

  async function getJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
    return body;
  }

  async function load({ fresh = false } = {}) {
    if (loading) return;
    loading = true;
    setStatus("loading", data ? "Refreshing…" : "Loading live data…");
    $("refresh").disabled = true;

    const historyP = getJson(`/data/history.json?t=${Date.now()}`).catch(() => ({ snapshots: [] }));
    try {
      const live = await getJson(`/api/stats${fresh ? `?fresh=${Date.now()}` : ""}`);
      data = { ...live, live: true };
    } catch (err) {
      // Live API unavailable: fall back to the last nightly copy.
      try {
        const saved = await getJson(`/data/latest.json?t=${Date.now()}`);
        data = { ...saved, live: false, error: err.message };
      } catch {
        data = { campaigns: [], live: false, error: err.message };
      }
    }
    snapshots = ((await historyP).snapshots || []).sort((a, b) => a.date.localeCompare(b.date));
    deltas = buildDeltas(snapshots, data.live ? data.campaigns : null, data.campaigns);

    loading = false;
    $("refresh").disabled = false;
    updateStatus();
    updateNotice();
    updateControls();
    render();
  }

  function setStatus(kind, text) {
    $("live-dot").dataset.state = kind;
    $("sync-status").textContent = text;
  }

  function updateStatus() {
    const when = data.updated_at ? new Date(data.updated_at) : null;
    const time = when ? when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";
    if (data.live) {
      setStatus("live", `Live · updated ${time}`);
    } else {
      setStatus("error", `Live data unavailable (${data.error}). Showing saved data from ${time}.`);
    }
  }

  function updateNotice() {
    const notes = [];
    if (!data.campaigns?.length) notes.push("No campaigns found in your Smartlead account yet.");
    if (data.failed?.length) {
      const n = data.failed.length;
      notes.push(`${n} campaign${n > 1 ? "s" : ""} couldn't be loaded this time and ${n > 1 ? "are" : "is"} missing from the totals. Refresh to try again.`);
    }
    if (!snapshots.length) {
      notes.push("Daily trends start after the first nightly snapshot (just after midnight IST). Until then you're seeing all-time totals.");
    } else if (snapshots.length < 90) {
      const first = new Date(`${snapshots[0].date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
      notes.push(`Daily history starts ${first}, so longer periods only cover days since then.`);
    }
    $("notice").textContent = notes.join(" ");
    $("notice").hidden = notes.length === 0;
  }

  /**
   * Snapshot for day D = totals at the start of D.
   * Activity on day D = snapshot(D+1) − snapshot(D), or live − snapshot(D) for today.
   * Campaigns created on the day history starts also get everything they did
   * before that first snapshot, so day one isn't undercounted.
   */
  function buildDeltas(snaps, liveCampaigns, allCampaigns) {
    const points = [...snaps];
    if (liveCampaigns) {
      points.push({ date: null, campaigns: Object.fromEntries(liveCampaigns.map((c) => [String(c.id), c])) });
    }
    const out = [];
    const lastSeen = {};
    for (let i = 0; i < points.length; i++) {
      const cur = points[i];
      if (i > 0) {
        const day = { date: points[i - 1].date, campaigns: {} };
        for (const [id, c] of Object.entries(cur.campaigns)) {
          const prev = lastSeen[id];
          const d = {};
          for (const m of METRICS) d[m] = Math.max(0, (c[m] || 0) - (prev ? prev[m] || 0 : 0));
          day.campaigns[id] = d;
        }
        out.push(day);
      }
      for (const [id, c] of Object.entries(cur.campaigns)) lastSeen[id] = c;
    }

    // Day-one backfill
    const first = snaps[0];
    if (first) {
      const created = Object.fromEntries((allCampaigns || []).map((c) => [String(c.id), localDate(c.created_at)]));
      let day = out.find((d) => d.date === first.date);
      if (!day) { day = { date: first.date, campaigns: {} }; out.unshift(day); }
      for (const [id, c] of Object.entries(first.campaigns)) {
        if (!created[id] || created[id] < first.date) continue;
        const d = (day.campaigns[id] ||= Object.fromEntries(METRICS.map((m) => [m, 0])));
        for (const m of METRICS) d[m] += c[m] || 0;
      }
      if (!Object.keys(day.campaigns).length) out.splice(out.indexOf(day), 1);
    }
    return out;
  }

  // YYYY-MM-DD of a timestamp in the dashboard's time zone (IST)
  function localDate(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts).slice(0, 10);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
  }

  // ---------- One-time setup ----------

  function setup() {
    document.querySelectorAll(".range button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.range = btn.dataset.range;
        document.querySelectorAll(".range button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        render();
      });
    });

    $("status-filter").addEventListener("change", (e) => { state.status = e.target.value; render(); });
    $("search").addEventListener("input", (e) => { state.search = e.target.value.toLowerCase(); renderTable(currentRows()); });

    document.querySelectorAll("thead th").forEach((th) => {
      th.tabIndex = 0;
      const sort = () => {
        const k = th.dataset.key;
        if (state.sortKey === k) state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
        else { state.sortKey = k; state.sortDir = k === "name" || k === "status" ? "asc" : "desc"; }
        renderTable(currentRows());
      };
      th.addEventListener("click", sort);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sort(); } });
    });

    $("refresh").addEventListener("click", () => load({ fresh: true }));
    $("export-csv").addEventListener("click", exportCsv);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderChart());

    // Auto-refresh while the tab is open; refresh immediately when you come back to it.
    const schedule = () => { clearInterval(timer); timer = setInterval(() => !document.hidden && load(), AUTO_REFRESH_MS); };
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && data?.updated_at && Date.now() - new Date(data.updated_at) > AUTO_REFRESH_MS) load();
    });
    schedule();
  }

  function updateControls() {
    const hasDeltas = deltas.length > 0;
    document.querySelectorAll(".range button").forEach((btn) => {
      btn.disabled = btn.dataset.range !== "all" && !hasDeltas;
    });
    if (!hasDeltas && state.range !== "all") {
      state.range = "all";
      document.querySelectorAll(".range button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === "all")));
    }

    const select = $("status-filter");
    const statuses = [...new Set((data.campaigns || []).map((c) => c.status))].sort();
    if (state.status && !statuses.includes(state.status)) state.status = "";
    select.innerHTML = `<option value="">All statuses</option>` +
      statuses.map((s) => `<option value="${esc(s)}"${s === state.status ? " selected" : ""}>${esc(titleCase(s))}</option>`).join("");
  }

  // ---------- Data shaping ----------

  function rangeDeltas() {
    if (state.range === "all") return deltas;
    const n = Number(state.range);
    const last = deltas.at(-1)?.date;
    if (!last) return [];
    const cutoff = new Date(`${last}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - n + 1);
    const cut = cutoff.toISOString().slice(0, 10);
    return deltas.filter((d) => d.date >= cut);
  }

  function currentRows() {
    const campaigns = data.campaigns || [];
    const byId = Object.fromEntries(campaigns.map((c) => [String(c.id), c]));
    let rows;
    if (state.range === "all") {
      rows = campaigns.map((c) => ({ ...c }));
    } else {
      const sums = {};
      for (const day of rangeDeltas()) {
        for (const [id, d] of Object.entries(day.campaigns)) {
          const s = (sums[id] ||= Object.fromEntries(METRICS.map((m) => [m, 0])));
          for (const m of METRICS) s[m] += d[m];
        }
      }
      rows = Object.entries(sums)
        .filter(([, s]) => METRICS.some((m) => s[m] > 0))
        .map(([id, s]) => ({
          id, name: byId[id]?.name || `Campaign ${id}`, status: byId[id]?.status || "UNKNOWN",
          plain_text: byId[id]?.plain_text, ...s,
        }));
    }
    if (state.status) rows = rows.filter((r) => r.status === state.status);
    return rows.map((r) => ({
      ...r,
      open_rate: r.plain_text ? null : pct(r.unique_opened, r.unique_sent),
      reply_rate: pct(r.replied, r.unique_sent),
      bounce_rate: pct(r.bounced, r.sent),
    }));
  }

  function totals(rows) {
    const t = Object.fromEntries(METRICS.map((m) => [m, 0]));
    for (const r of rows) for (const m of METRICS) t[m] += r[m] || 0;
    return t;
  }

  // ---------- Rendering ----------

  function render() {
    const rows = currentRows();
    renderFunnel(rows);
    renderChart();
    renderTable(rows);
  }

  function renderFunnel(rows) {
    const t = totals(rows);
    const base = t.unique_sent || t.sent || 0;
    const stages = [
      { label: "Emails sent", value: t.sent, color: "--sent", note: `${fmt.format(t.unique_sent)} unique leads`, width: t.sent > 0 ? 1 : 0 },
      { label: "Opened", value: t.unique_opened, color: "--opened", note: `${fmtPct(pct(t.unique_opened, base))} open rate`, width: pct(t.unique_opened, base) },
      { label: "Clicked", value: t.clicked, color: "--clicked", note: `${fmtPct(pct(t.clicked, base))} of leads`, width: pct(t.clicked, base) },
      { label: "Replied", value: t.replied, color: "--replied", note: `${fmtPct(pct(t.replied, base))} reply rate`, width: pct(t.replied, base) },
    ];
    $("funnel").innerHTML = stages.map((s) => `
      <div class="stage" style="--c: var(${s.color})">
        <div class="stage-num">${fmt.format(s.value)}</div>
        <div>
          <div class="stage-label"><strong>${s.label}</strong><span>${s.note}</span></div>
          <div class="bar"><i data-w="${Math.min(1, s.width || 0)}"></i></div>
        </div>
      </div>`).join("");
    requestAnimationFrame(() => {
      document.querySelectorAll(".bar > i").forEach((el) => {
        const w = Number(el.dataset.w);
        el.style.width = w > 0 ? `max(${(w * 100).toFixed(2)}%, 4px)` : "0";
      });
    });

    const active = rows.filter((r) => r.status === "ACTIVE").length;
    const periodLabel = state.range === "all" ? "all time" : `last ${state.range} days (incl. today)`;
    $("side-stats").innerHTML = `
      <div><dt>Bounced</dt><dd>${fmt.format(t.bounced)}<small>${fmtPct(pct(t.bounced, t.sent))}</small></dd></div>
      <div><dt>Unsubscribed</dt><dd>${fmt.format(t.unsubscribed)}<small>${fmtPct(pct(t.unsubscribed, base))}</small></dd></div>
      <div><dt>Campaigns shown</dt><dd>${rows.length}<small>${active} active</small></dd></div>
      <div><dt>Period</dt><dd style="font-size:1rem;font-weight:400">${periodLabel}</dd></div>`;
  }

  function renderChart() {
    const days = rangeDeltas();
    const empty = $("chart-empty");
    const wrap = $("chart-wrap");
    if (!days.length || typeof Chart === "undefined") {
      wrap.hidden = true;
      empty.hidden = false;
      empty.textContent = typeof Chart === "undefined"
        ? "The chart library didn't load. Check your connection and refresh."
        : "Daily activity appears after the first nightly snapshot (just after midnight IST).";
      $("trend-sub").textContent = "";
      return;
    }
    wrap.hidden = false;
    empty.hidden = true;

    const filterIds = state.status
      ? new Set((data.campaigns || []).filter((c) => c.status === state.status).map((c) => String(c.id)))
      : null;
    const series = { sent: [], unique_opened: [], replied: [] };
    for (const day of days) {
      const s = { sent: 0, unique_opened: 0, replied: 0 };
      for (const [id, d] of Object.entries(day.campaigns)) {
        if (filterIds && !filterIds.has(id)) continue;
        s.sent += d.sent; s.unique_opened += d.unique_opened; s.replied += d.replied;
      }
      for (const k in series) series[k].push(s[k]);
    }
    const lastIsToday = data.live;
    $("trend-sub").textContent = `${days[0].date} to ${days.at(-1).date}${lastIsToday ? " · today so far is live" : ""}`;

    const labels = days.map((d, i) => {
      const l = new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      return lastIsToday && i === days.length - 1 ? `${l} (today)` : l;
    });
    const ink = cssVar("--muted");
    const rule = cssVar("--rule");
    const narrow = window.innerWidth < 600;
    const ds = (label, values, color, axis) => ({
      label, data: values, yAxisID: axis, borderColor: color, backgroundColor: color,
      borderWidth: 2, pointRadius: days.length > (narrow ? 14 : 45) ? 0 : 2.5, pointHoverRadius: 5, tension: 0.25,
      segment: lastIsToday ? { borderDash: (ctx) => (ctx.p1DataIndex === days.length - 1 ? [4, 4] : undefined) } : undefined,
    });

    Chart.defaults.font.family = cssVar("--font");
    const config = {
      type: "line",
      data: {
        labels,
        datasets: [
          ds("Sent", series.sent, cssVar("--sent"), "y"),
          ds("Opened (unique)", series.unique_opened, cssVar("--opened"), "y"),
          ds("Replies", series.replied, cssVar("--replied"), "y2"),
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 400 },
        plugins: {
          legend: { position: "top", align: "start", labels: { color: ink, boxWidth: 12, boxHeight: 2 } },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt.format(c.parsed.y)}` } },
        },
        scales: {
          x: { ticks: { color: ink, maxRotation: 0, autoSkipPadding: 16 }, grid: { display: false }, border: { color: rule } },
          y: { beginAtZero: true, ticks: { color: ink, precision: 0 }, grid: { color: rule }, border: { display: false },
               title: { display: true, text: "Sent / opened", color: ink } },
          y2: { position: "right", beginAtZero: true, ticks: { color: ink, precision: 0 }, grid: { display: false }, border: { display: false },
                title: { display: true, text: "Replies", color: ink } },
        },
      },
    };
    if (chart) chart.destroy();
    chart = new Chart($("trend-chart"), config);
  }

  function renderTable(rows) {
    let list = rows;
    if (state.search) list = list.filter((r) => r.name.toLowerCase().includes(state.search));
    const { sortKey: k, sortDir } = state;
    const dir = sortDir === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => {
      const va = a[k], vb = b[k];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
    });

    document.querySelectorAll("thead th").forEach((th) => {
      th.setAttribute("aria-sort", th.dataset.key === k ? (sortDir === "asc" ? "ascending" : "descending") : "none");
    });

    const n = (v) => fmt.format(v || 0);
    const p = (v) => (v == null ? `<td class="na">–</td>` : `<td>${fmtPct(v)}</td>`);
    $("campaign-table").querySelector("tbody").innerHTML = list.map((r) => `
      <tr>
        <td class="text name">${esc(r.name)}</td>
        <td class="text"><span class="status" data-s="${esc(r.status)}">${esc(titleCase(r.status))}</span></td>
        <td>${n(r.sent)}</td>
        ${r.plain_text ? `<td class="na" title="Plain-text campaign: opens not tracked">–</td>` : `<td>${n(r.unique_opened)}</td>`}
        ${p(r.open_rate)}
        <td>${n(r.clicked)}</td>
        <td>${n(r.replied)}</td>
        ${p(r.reply_rate)}
        <td>${n(r.bounced)}</td>
        ${p(r.bounce_rate)}
      </tr>`).join("");

    const empty = $("table-empty");
    empty.hidden = list.length > 0;
    empty.textContent = rows.length === 0
      ? (state.range === "all" ? "No campaigns yet." : "No campaign activity in this period.")
      : "No campaigns match your search.";
  }

  function exportCsv() {
    const rows = currentRows().filter((r) => !state.search || r.name.toLowerCase().includes(state.search));
    const cols = ["name", "status", "sent", "unique_sent", "unique_opened", "open_rate", "clicked", "replied", "reply_rate", "bounced", "bounce_rate", "unsubscribed"];
    const cell = (v) => {
      if (v == null) return "";
      const s = typeof v === "number" && !Number.isInteger(v) ? v.toFixed(4) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `smartlead-${state.range === "all" ? "all-time" : `last-${state.range}-days`}-${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  setup();
  load();
})();
