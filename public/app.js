// public/app.js
(() => {
  "use strict";

  const METRICS = ["sent", "unique_sent", "unique_opened", "clicked", "replied", "bounced", "unsubscribed"];
  const AUTO_REFRESH_MS = 5 * 60 * 1000;

  const state = { range: "all", granularity: "day", sortKey: "sent", sortDir: "desc", search: "", status: "" };
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
    document.querySelectorAll(".range:not(.granularity) button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.range = btn.dataset.range;
        document.querySelectorAll(".range:not(.granularity) button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
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

    document.querySelectorAll(".granularity button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.granularity = btn.dataset.g;
        document.querySelectorAll(".granularity button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        renderChart();
      });
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
    document.querySelectorAll(".range:not(.granularity) button").forEach((btn) => {
      btn.disabled = btn.dataset.range !== "all" && !hasDeltas;
    });
    if (!hasDeltas && state.range !== "all") {
      state.range = "all";
      document.querySelectorAll(".range:not(.granularity) button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === "all")));
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
          // lead counts are current totals, not activity, so they come from the live data
          leads_total: byId[id]?.leads_total, leads_not_started: byId[id]?.leads_not_started,
          leads_in_progress: byId[id]?.leads_in_progress, leads_completed: byId[id]?.leads_completed,
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

    // Total leads = the same campaigns as the table below, so the numbers always add up.
    const leadsTotal = rows.reduce((a, r) => a + (r.leads_total || 0), 0);
    const leadsWaiting = rows.some((r) => r.leads_not_started != null)
      ? rows.reduce((a, r) => a + (r.leads_not_started || 0), 0) : null;
    // Leads in campaigns not shown (paused, or no activity in this period)
    const shownIds = new Set(rows.map((r) => String(r.id)));
    const hidden = (data.campaigns || []).filter((c) => !shownIds.has(String(c.id)) && (!state.status || c.status === state.status));
    const leadsHidden = hidden.reduce((a, c) => a + (c.leads_total || 0), 0);
    const scale = leadsTotal || base; // bars are drawn relative to total leads

    const stages = [
      { label: `Total leads · ${rows.length} campaign${rows.length === 1 ? "" : "s"}`, value: leadsTotal, color: "--leads",
        note: leadsWaiting == null ? "uploaded to campaigns" : `${fmt.format(leadsWaiting)} yet to start`, width: leadsTotal > 0 ? 1 : 0,
        extra: leadsHidden ? `+ ${fmt.format(leadsHidden)} more in ${hidden.length} other campaign${hidden.length === 1 ? "" : "s"} (paused or no activity in this period)` : "" },
      { label: "Emails sent", value: t.sent, color: "--sent",
        note: `${fmt.format(t.unique_sent)} leads contacted${leadsTotal ? ` · ${fmtPct(pct(t.unique_sent, leadsTotal))} of leads` : ""}`, width: pct(t.unique_sent, scale) },
      { label: "Opened", value: t.unique_opened, color: "--opened", note: `${fmtPct(pct(t.unique_opened, base))} open rate`, width: pct(t.unique_opened, scale) },
      { label: "Clicked", value: t.clicked, color: "--clicked", note: `${fmtPct(pct(t.clicked, base))} click rate`, width: pct(t.clicked, scale) },
      { label: "Replied", value: t.replied, color: "--replied", note: `${fmtPct(pct(t.replied, base))} reply rate`, width: pct(t.replied, scale) },
    ];
    $("funnel").innerHTML = stages.map((s) => `
      <div class="stage" style="--c: var(${s.color})">
        <div class="stage-num">${fmt.format(s.value)}</div>
        <div>
          <div class="stage-label"><strong>${s.label}</strong><span>${s.note}</span></div>
          <div class="bar"><i data-w="${Math.min(1, s.width || 0)}"></i></div>
          ${s.extra ? `<p class="stage-extra">${s.extra}</p>` : ""}
        </div>
      </div>`).join("");
    requestAnimationFrame(() => {
      document.querySelectorAll(".bar > i").forEach((el) => {
        const w = Number(el.dataset.w);
        el.style.width = w > 0 ? `max(${(w * 100).toFixed(2)}%, 4px)` : "0";
      });
    });

    const everyCampaign = data.campaigns || [];
    const active = everyCampaign.filter((c) => c.status === "ACTIVE").length;
    const paused = everyCampaign.filter((c) => c.status === "PAUSED").length;
    const periodLabel = state.range === "all" ? "all time" : `last ${state.range} days (incl. today)`;
    $("side-stats").innerHTML = `
      <div class="highlight"><dt>Active campaigns</dt><dd>${active}<small>of ${everyCampaign.length} total${paused ? ` · ${paused} paused` : ""}</small></dd></div>
      <div><dt>Bounced</dt><dd>${fmt.format(t.bounced)}<small>${fmtPct(pct(t.bounced, t.sent))}</small></dd></div>
      <div><dt>Unsubscribed</dt><dd>${fmt.format(t.unsubscribed)}<small>${fmtPct(pct(t.unsubscribed, base))}</small></dd></div>
      <div><dt>Period</dt><dd style="font-size:1rem;font-weight:400">${periodLabel}${rows.length !== everyCampaign.length ? `<br><small style="margin:0">${rows.length} campaign${rows.length === 1 ? "" : "s"} with activity</small>` : ""}</dd></div>`;
  }

  // Chart buckets: day, week of the month (1–7, 8–14, 15–21, 22–28, 29–end), or month
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
  function bucketOf(date, granularity) {
    const [y, m, d] = date.split("-").map(Number);
    const mon = MONTHS[m - 1];
    if (granularity === "week") {
      const wk = Math.ceil(d / 7);
      const first = (wk - 1) * 7 + 1;
      const last = wk === 5 ? lastDayOfMonth(y, m) : wk * 7;
      return { key: `${y}-${String(m).padStart(2, "0")}-w${wk}`, label: `${mon} · Wk ${wk}`, range: `${mon} ${first}–${last}, ${y}` };
    }
    if (granularity === "month") {
      return { key: `${y}-${String(m).padStart(2, "0")}`, label: `${mon} ${y}`, range: `${mon} 1–${lastDayOfMonth(y, m)}, ${y}` };
    }
    return { key: date, label: `${mon} ${d}`, range: `${mon} ${d}, ${y}` };
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
        : "Activity appears after the first nightly snapshot (just after midnight IST).";
      $("trend-sub").textContent = "";
      return;
    }
    wrap.hidden = false;
    empty.hidden = true;

    const filterIds = state.status
      ? new Set((data.campaigns || []).filter((c) => c.status === state.status).map((c) => String(c.id)))
      : null;

    // Sum each day, then group into weeks if asked
    const perDay = days.map((day) => {
      const s = { date: day.date, sent: 0, unique_opened: 0, clicked: 0, replied: 0 };
      for (const [id, d] of Object.entries(day.campaigns)) {
        if (filterIds && !filterIds.has(id)) continue;
        s.sent += d.sent; s.unique_opened += d.unique_opened; s.clicked += d.clicked; s.replied += d.replied;
      }
      return s;
    });
    const g = state.granularity;
    const grouped = g === "week" || g === "month";
    const map = new Map();
    for (const d of perDay) {
      const info = bucketOf(d.date, g);
      const bk = map.get(info.key) || { ...info, sent: 0, unique_opened: 0, clicked: 0, replied: 0, days: 0 };
      bk.sent += d.sent; bk.unique_opened += d.unique_opened; bk.clicked += d.clicked; bk.replied += d.replied; bk.days++;
      map.set(info.key, bk);
    }
    const buckets = [...map.values()];

    const todayLive = data.live;
    const currentWord = { day: "today", week: "this week", month: "this month" }[g] || "today";
    const labels = buckets.map((b, i) => `${b.label}${i === buckets.length - 1 && todayLive ? ` (${currentWord})` : ""}`);
    const sum = (k) => buckets.reduce((a, b) => a + b[k], 0);
    $("trend-sub").textContent =
      `${fmt.format(sum("sent"))} sent · ${fmt.format(sum("unique_opened"))} opened · ${fmt.format(sum("replied"))} replies` +
      (todayLive ? ` · ${currentWord} so far is live` : "");

    const ink = cssVar("--muted");
    const rule = cssVar("--rule");
    const narrow = window.innerWidth < 600;
    const last = buckets.length - 1;
    // Line chart for every view; the last point is still in progress, so its segment is dashed
    const ds = (label, key, color, axis) => ({
      label, data: buckets.map((b) => b[key]), yAxisID: axis, borderColor: color, backgroundColor: color,
      type: "line", borderWidth: 2, tension: 0.25, pointHoverRadius: 6,
      pointRadius: buckets.length > (narrow ? 14 : 45) ? 0 : grouped ? 4 : 3,
      segment: todayLive ? { borderDash: (ctx) => (ctx.p1DataIndex === last ? [4, 4] : undefined) } : undefined,
    });

    Chart.defaults.font.family = cssVar("--font");
    const config = {
      type: "line",
      data: {
        labels,
        datasets: [
          ds("Sent", "sent", cssVar("--sent"), "y"),
          ds("Opened (unique)", "unique_opened", cssVar("--opened"), "y"),
          ds("Clicks", "clicked", cssVar("--clicked"), "y2"),
          ds("Replies", "replied", cssVar("--replied"), "y2"),
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 400 },
        plugins: {
          legend: { position: "top", align: "start", labels: { color: ink, boxWidth: 12, boxHeight: 2 } },
          tooltip: {
            callbacks: {
              title: (items) => {
                const b = buckets[items[0].dataIndex];
                return grouped ? `${b.label} (${b.range})` : b.range;
              },
              label: (c) => ` ${c.dataset.label}: ${fmt.format(c.parsed.y)}`,
              afterBody: (items) => {
                const b = buckets[items[0].dataIndex];
                const rate = b.sent ? ` · open rate ${fmtPct(pct(b.unique_opened, b.sent))}` : "";
                return grouped ? `${b.days} day${b.days === 1 ? "" : "s"} of data${rate}` : rate.replace(" · ", "");
              },
            },
          },
        },
        scales: {
          x: {
            // weeks and months: label every point (only skip when there are too many to fit)
            ticks: { color: ink, maxRotation: 0, autoSkip: !grouped || buckets.length > (narrow ? 5 : 14), autoSkipPadding: 12, font: { size: grouped ? 11 : 12 } },
            grid: { display: false }, border: { color: rule },
          },
          y: { beginAtZero: true, ticks: { color: ink, precision: 0 }, grid: { color: rule }, border: { display: false },
               title: { display: true, text: "Sent / opened", color: ink } },
          y2: { position: "right", beginAtZero: true, ticks: { color: ink, precision: 0 }, grid: { display: false }, border: { display: false },
                title: { display: true, text: "Clicks / replies", color: ink } },
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
        <td>${r.leads_total == null ? "–" : n(r.leads_total)}</td>
        <td>${r.leads_not_started == null ? `<span class="na">–</span>` : n(r.leads_not_started)}</td>
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
    const byId = Object.fromEntries((data.campaigns || []).map((c) => [String(c.id), c]));
    const rows = currentRows()
      .filter((r) => !state.search || r.name.toLowerCase().includes(state.search))
      .map((r) => ({ ...byId[String(r.id)], ...r })); // add campaign details (created, lead stats) in period views
    const allTime = state.range === "all";
    const ist = (t) => (t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "");
    const p = (v) => (v == null ? "" : `${(v * 100).toFixed(2)}%`);
    const cell = (v) => {
      const str = v == null ? "" : String(v);
      return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const line = (arr) => arr.map(cell).join(",");

    const cols = [
      ["Campaign", (r) => r.name],
      ["Campaign ID", (r) => r.id],
      ["Status", (r) => titleCase(r.status)],
      ["Created (IST)", (r) => ist(r.created_at)],
      ["Total leads", (r) => r.leads_total],
      ["Yet to start", (r) => r.leads_not_started],
      ["In progress", (r) => r.leads_in_progress],
      ["Completed", (r) => r.leads_completed],
      ["Blocked", (r) => r.leads_blocked],
      ["Emails sent", (r) => r.sent],
      ["Leads contacted", (r) => r.unique_sent],
      ["% of leads contacted", (r) => p(pct(r.unique_sent, r.leads_total))],
      ["Opens (total)", (r) => (allTime ? r.opened : "")],
      ["Unique opens", (r) => (r.plain_text ? "" : r.unique_opened)],
      ["Open rate", (r) => p(r.open_rate)],
      ["Clicks", (r) => r.clicked],
      ["Unique clicks", (r) => (allTime ? r.unique_clicked : "")],
      ["Click rate", (r) => p(pct(r.clicked, r.unique_sent))],
      ["Replies", (r) => r.replied],
      ["Reply rate", (r) => p(r.reply_rate)],
      ["Interested leads", (r) => r.leads_interested],
      ["Bounced", (r) => r.bounced],
      ["Bounce rate", (r) => p(r.bounce_rate)],
      ["Unsubscribed", (r) => r.unsubscribed],
      ["Unsubscribe rate", (r) => p(pct(r.unsubscribed, r.unique_sent))],
      ["Plain text (no open tracking)", (r) => (r.plain_text ? "Yes" : "No")],
    ];

    // Totals row
    const sumKeys = ["leads_total", "leads_not_started", "leads_in_progress", "leads_completed", "leads_blocked", "sent", "unique_sent",
      "opened", "unique_opened", "clicked", "unique_clicked", "replied", "leads_interested", "bounced", "unsubscribed"];
    const T = Object.fromEntries(sumKeys.map((k) => [k, rows.reduce((a, r) => a + (Number(r[k]) || 0), 0)]));
    Object.assign(T, {
      name: "TOTAL", id: "", status: "", created_at: null,
      open_rate: pct(T.unique_opened, T.unique_sent), reply_rate: pct(T.replied, T.unique_sent), bounce_rate: pct(T.bounced, T.sent),
    });

    const periodText = allTime ? "All time" : `Last ${state.range} days including today (IST)`;
    const out = [
      line(["Smartlead campaign report"]),
      line(["Period", periodText]),
      line(["Status filter", state.status ? titleCase(state.status) : "All statuses"]),
      line(["Data as of (IST)", ist(data.updated_at)]),
      line(["Exported at (IST)", ist(new Date().toISOString())]),
      line(["Campaigns in file", rows.length]),
      "",
      line(cols.map(([h]) => h)),
      ...rows.map((r) => line(cols.map(([, f]) => f(r)))),
      line(cols.map(([h, f]) => (h === "Plain text (no open tracking)" ? "" : f(T)))),
    ];

    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + out.join("\r\n")], { type: "text/csv;charset=utf-8" }));
    a.download = `smartlead-campaigns-${allTime ? "all-time" : `last-${state.range}-days`}-${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  setup();
  load();
})();
