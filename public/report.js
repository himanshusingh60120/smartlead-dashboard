// public/report.js
(() => {
  "use strict";

  const METRICS = ["sent", "unique_sent", "unique_opened", "clicked", "replied", "bounced", "unsubscribed"];
  const TIME_ZONE = "Asia/Kolkata";
  const PAGE = 50;
  const MAX_RANGE_DAYS = 93; // keep in sync with lib/report.js

  // ---------- Loading speed ----------
  // Smartlead allows only 10 requests a minute here, so each request should carry as many leads
  // as possible (up to 1,000). Batches aim for ~30s each and only shrink when a request fails.
  // Long windows are split into pieces of a few days, loaded 3 at a time.
  const BATCH = { min: 50, max: 1000, target: 30000 };
  let batchLimit = 500;
  const START_PIECE_DAYS = 3;
  let pieceDays = START_PIECE_DAYS; // shrinks if Smartlead struggles, for the rest of this visit
  const PARALLEL = 3;

  // Reply categories in display order. Keys must match lib/reply-categories.js.
  const REPLY_GROUPS = [
    { key: "positive", label: "Positive", cats: ["interested", "meeting", "info"] },
    { key: "negative", label: "Negative", cats: ["not_interested", "not_now", "unsubscribe", "out_of_office", "vacation", "wrong_person", "bounce"] },
    { key: "review", label: "Needs review", cats: ["review"] },
  ];
  const CAT_LABELS = {
    interested: "Interested",
    meeting: "Meeting request",
    info: "Information request",
    not_interested: "Not interested",
    not_now: "Not now / later",
    unsubscribe: "Remove me / unsubscribe",
    out_of_office: "Out of office",
    vacation: "Vacation / on leave",
    wrong_person: "Wrong person / left company",
    bounce: "Bounce / delivery failure",
    review: "Needs review",
  };
  const GROUP_OF = Object.fromEntries(REPLY_GROUPS.flatMap((g) => g.cats.map((c) => [c, g.key])));
  const GROUP_LABEL = Object.fromEntries(REPLY_GROUPS.map((g) => [g.key, g.label]));
  const GROUP_RANK = { positive: 0, negative: 1, review: 2 };
  const AUTO_REPLIES = new Set(["out_of_office", "vacation", "bounce"]);
  const SOURCE_LABEL = { smartlead: "tagged in Smartlead", "reply text": "matched from the reply", none: "no match, check by hand" };
  const catOf = (r) => {
    if (r?.reply_category === "referral") return "not_interested"; // older results
    return CAT_LABELS[r?.reply_category] ? r.reply_category : "review";
  };
  const groupOf = (r) => GROUP_OF[catOf(r)];

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
  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
  const startIso = (date) => new Date(`${date}T00:00:00.000+05:30`).toISOString();
  const timeIST = (t) => (t ? new Date(t).toLocaleString(undefined, { timeZone: TIME_ZONE, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "–");
  const longDate = (date) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const shortDate = (date) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const dayMonth = (date) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const pieceLabel = (s) => (s.from === s.to ? dayMonth(s.from) : `${dayMonth(s.from)}–${dayMonth(s.to)}`);
  const pctOf = (n, d) => (n != null && d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "");
  const dur = (secs) => {
    if (secs < 90) return `${secs}s`;
    if (secs < 3600) return `${Math.round(secs / 60)} min`;
    return `${Math.floor(secs / 3600)} h ${Math.round((secs % 3600) / 60)} min`;
  };

  let report = null;      // last loaded report for the window on screen, used by the CSV export
  let shown = null;       // report currently drawn (may still be loading)
  let lastSummary = null; // { sent, steps } used by the CSV export
  let requestId = 0;
  let current = null;     // { from, to }
  let replyFilter = "all";

  async function getJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(body.error || `Request failed (${r.status})`);
      err.status = r.status;
      throw err;
    }
    return body;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setStatus(kind, text) {
    $("live-dot").dataset.state = kind;
    $("sync-status").textContent = text;
  }

  // ---------- Windows ----------
  const PRESETS = {
    today: () => ({ from: today(), to: today() }),
    yesterday: () => { const y = addDays(today(), -1); return { from: y, to: y }; },
    "7": () => ({ from: addDays(today(), -7), to: addDays(today(), -1) }),   // 7 full days, ending yesterday
    "30": () => ({ from: addDays(today(), -30), to: addDays(today(), -1) }), // 30 full days, ending yesterday
    month: () => ({ from: `${today().slice(0, 8)}01`, to: today() }),
  };
  const PRESET_TITLES = { today: "Today so far", yesterday: "Yesterday", "7": "Last 7 days", "30": "Last 30 days", month: "This month" };

  function presetOf(w) {
    for (const [k, fn] of Object.entries(PRESETS)) {
      const p = fn();
      if (p.from === w.from && p.to === w.to) return k;
    }
    return null;
  }
  function titleFor(w) {
    const p = presetOf(w);
    if (p) return PRESET_TITLES[p];
    return w.from === w.to ? "Daily report" : "Custom window";
  }
  const windowLabel = (w) => (w.from === w.to ? longDate(w.from) : `${shortDate(w.from)} – ${shortDate(w.to)}`);
  const winKey = (w) => `${w.from}_${w.to}`;

  function clampWindow(from, to) {
    const t = today();
    if (!isDate(from)) from = t;
    if (!isDate(to)) to = t;
    if (from > t) from = t;
    if (to > t) to = t;
    if (from > to) [from, to] = [to, from];
    let clipped = false;
    if (daysBetween(from, to) > MAX_RANGE_DAYS) {
      from = addDays(to, -(MAX_RANGE_DAYS - 1));
      clipped = true;
    }
    return { from, to, clipped };
  }

  function markPreset(w) {
    const p = presetOf(w);
    document.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === p)));
  }

  function splitWindow({ from, to }, size) {
    const out = [];
    for (let f = from; f <= to; f = addDays(f, size)) {
      const t = addDays(f, size - 1);
      out.push({ from: f, to: t < to ? t : to });
    }
    return out;
  }

  // ---------- Window totals from daily snapshots ----------
  // Used only for numbers Smartlead doesn't timestamp (opens, clicks, bounces, unsubscribes).
  // A window is only counted when it starts and ends on a snapshot taken around midnight IST.
  const hourIST = (t) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(new Date(t)));

  async function rangeTotals({ from, to }) {
    const hist = await getJson(`/data/history.json?t=${Date.now()}`).catch(() => ({ snapshots: [] }));
    const list = [...(hist.snapshots || [])].sort((a, b) => a.date.localeCompare(b.date));
    const snaps = Object.fromEntries(list.map((s) => [s.date, s]));
    // Older snapshots have no taken_at: the very first one was a manual daytime run, the rest ran at midnight.
    const atMidnight = (snap) => Boolean(snap) && (snap.taken_at ? hourIST(snap.taken_at) < 4 : snap !== list[0]);

    const start = snaps[from];
    if (!atMidnight(start)) return null;
    const isToday = to === today();
    let end = snaps[addDays(to, 1)];
    if (end && !atMidnight(end)) return null;
    if (!end) {
      // Only a window ending today can use live numbers as its end point. A window ending
      // yesterday, before tonight's snapshot, would otherwise include today's activity.
      if (!isToday) return null;
      const live = await getJson("/api/stats").catch(() => null);
      if (!live) return null;
      end = { campaigns: Object.fromEntries(live.campaigns.map((c) => [String(c.id), c])) };
    }

    const totals = Object.fromEntries(METRICS.map((m) => [m, 0]));
    for (const [id, c] of Object.entries(end.campaigns)) {
      const base = start.campaigns[id]; // missing = campaign created during the window
      for (const m of METRICS) totals[m] += Math.max(0, (c[m] || 0) - (base ? base[m] || 0 : 0));
    }
    return { totals, isToday };
  }

  // ---------- Pacing: Smartlead allows 10 lead-activity requests a minute ----------
  // We stay one under the limit (across all parallel loads), so there's no 60-second penalty to wait out.
  const RATE = { max: 9, windowMs: 61000 };
  const recentStarts = [];
  async function waitForTurn(isCurrent, onWait) {
    for (;;) {
      const now = Date.now();
      while (recentStarts.length && now - recentStarts[0] > RATE.windowMs) recentStarts.shift();
      if (recentStarts.length < RATE.max) {
        recentStarts.push(now);
        return;
      }
      if (!isCurrent()) return;
      const waitMs = RATE.windowMs - (now - recentStarts[0]) + 100;
      onWait(Math.ceil(waitMs / 1000));
      await sleep(Math.min(1000, waitMs));
    }
  }

  // ---------- Collected data (merged from every piece of the window) ----------
  const emptyPart = () => ({
    sums: { leads_with_activity: 0, sent_in_window: 0, replies_in_window: 0 },
    replies_by_step: {},
    sentLeads: new Set(),
    touched: {}, // step -> Set of emails
    replied: [], clicked: [], opened: [],
  });
  const pushAll = (into, rows) => { for (const r of rows || []) into.push(r); };

  function addChunk(p, chunk) {
    const c = chunk.counts || {};
    for (const k of Object.keys(p.sums)) p.sums[k] += c[k] || 0;
    for (const [s, n] of Object.entries(c.replies_by_step || {})) p.replies_by_step[s] = (p.replies_by_step[s] || 0) + n;
    for (const id of chunk.sent_leads || []) p.sentLeads.add(id);
    for (const [s, list] of Object.entries(chunk.touched_emails_by_step || {})) {
      const set = (p.touched[s] ||= new Set());
      for (const e of list) set.add(e);
    }
    pushAll(p.replied, chunk.replied);
    pushAll(p.clicked, chunk.clicked);
    pushAll(p.opened, chunk.opened);
  }

  function mergePart(into, part) {
    for (const k of Object.keys(into.sums)) into.sums[k] += part.sums[k] || 0;
    for (const [s, n] of Object.entries(part.replies_by_step)) into.replies_by_step[s] = (into.replies_by_step[s] || 0) + n;
    part.sentLeads.forEach((id) => into.sentLeads.add(id));
    for (const [s, set] of Object.entries(part.touched)) {
      const t = (into.touched[s] ||= new Set());
      set.forEach((e) => t.add(e));
    }
    pushAll(into.replied, part.replied);
    pushAll(into.clicked, part.clicked);
    pushAll(into.opened, part.opened);
  }

  // Turns everything collected so far into one report. The same email can show up in two
  // pieces (e.g. sent in one, replied to in the next), so rows are de-duplicated.
  function buildReport(win, all) {
    const rowKey = (r) => `${r.lead_id}|${r.campaign_id}|${r.seq}|${r.sent_time}`;
    const dedupe = (rows, pick) => {
      const m = new Map();
      for (const r of rows) {
        const k = rowKey(r);
        const prev = m.get(k);
        m.set(k, prev ? pick(prev, r) : r);
      }
      return [...m.values()];
    };
    const pickRow = (a, b) => (a.sent_in_window || !b.sent_in_window ? a : { ...a, sent_in_window: true });
    const pickReply = (a, b) => {
      const later = new Date(b.reply_time) > new Date(a.reply_time) ? b : a;
      return { ...later, sent_in_window: a.sent_in_window || b.sent_in_window };
    };

    return finalize({
      key: winKey(win),
      from_date: win.from,
      to_date: win.to,
      from: startIso(win.from),
      to: startIso(addDays(win.to, 1)),
      source: "live",
      counts: {
        leads_with_activity: all.sums.leads_with_activity,
        sent_in_window: all.sums.sent_in_window,
        leads_sent_in_window: all.sentLeads.size,
        replies_in_window: all.sums.replies_in_window,
        touched_by_step: Object.fromEntries(Object.entries(all.touched).map(([k, v]) => [k, v.size])),
        replies_by_step: { ...all.replies_by_step },
      },
      replied: dedupe(all.replied, pickReply),
      clicked: dedupe(all.clicked, pickRow),
      opened: dedupe(all.opened, pickRow),
      generated_at: new Date().toISOString(),
    });
  }

  function finalize(rep) {
    const uniq = (rows) => new Set(rows.map((r) => r.lead_id)).size;
    rep.counts.opened = uniq(rep.opened);
    rep.counts.clicked = uniq(rep.clicked);
    rep.counts.replied = uniq(rep.replied);

    // Reply breakdown: each lead counted once, by its latest reply in the window
    const latest = new Map();
    for (const r of rep.replied) {
      const prev = latest.get(r.lead_id);
      if (!prev || new Date(r.reply_time) > new Date(prev.reply_time)) latest.set(r.lead_id, r);
    }
    const groups = { positive: 0, negative: 0, review: 0 };
    const cats = {};
    let auto = 0;
    for (const r of latest.values()) {
      const k = catOf(r);
      cats[k] = (cats[k] || 0) + 1;
      groups[GROUP_OF[k]]++;
      if (AUTO_REPLIES.has(k)) auto++;
    }
    rep.counts.reply_groups = groups;
    rep.counts.reply_categories = cats;
    rep.counts.auto_replies = auto;

    rep.replied.sort((a, b) => new Date(b.reply_time) - new Date(a.reply_time));
    rep.clicked.sort((a, b) => b.clicks - a.clicks);
    rep.opened.sort((a, b) => b.opens - a.opens);
    return rep;
  }

  // ---------- Live data, fetched from Smartlead ----------
  // Loads one piece of the window into `part`, batch by batch.
  // When a request fails: first smaller batches at the same spot, then (for multi-day pieces) an
  // error with .splittable so the piece is retried as shorter ranges, then a few retries for one day.
  async function fetchPiece(seg, part, isCurrent, progress) {
    const multiDay = daysBetween(seg.from, seg.to) > 1;
    let offset = 0;
    let failures = 0;
    let checkedEnd = false;

    while (isCurrent()) {
      await waitForTurn(isCurrent, (s) => progress(`pacing for Smartlead's 10-a-minute limit, next request in ${s}s`));
      if (!isCurrent()) break;
      const limit = batchLimit;

      let chunk;
      try {
        chunk = await getJson(`/api/report?from=${seg.from}&to=${seg.to}&offset=${offset}&limit=${limit}&t=${Date.now()}`);
        failures = 0;
      } catch (err) {
        if (err.status === 429) {
          for (let s = 60; s > 0 && isCurrent(); s--) {
            progress(`Smartlead's rate limit was hit, continuing in ${s}s`);
            await sleep(1000);
          }
          continue;
        }
        if (err.status === 400) throw err; // the request itself is wrong; retrying won't help
        if (limit > 100) {
          batchLimit = Math.max(BATCH.min, Math.floor(limit / 2));
          progress("Smartlead is slow, using smaller batches");
          continue;
        }
        if (multiDay) {
          const e = new Error(err.message);
          e.splittable = true;
          throw e;
        }
        failures++;
        if (failures <= 3) {
          batchLimit = Math.max(BATCH.min, Math.floor(limit / 2));
          progress("Smartlead is slow, retrying");
          await sleep(2000 * failures);
          continue;
        }
        throw err;
      }

      addChunk(part, chunk);
      offset += chunk.received;
      progress("");

      if (chunk.received === 0) break;
      const short = chunk.received < limit;
      if (short) {
        // A short page is normally the last one. Stop if Smartlead agrees; if it didn't say, check once.
        if (chunk.hasMore === false || checkedEnd) break;
        if (chunk.hasMore == null) checkedEnd = true;
        continue;
      }
      // Full page: size the next batch so a request takes about BATCH.target ms
      if (chunk.smartlead_ms > 0) {
        const next = limit * (BATCH.target / chunk.smartlead_ms);
        batchLimit = Math.round(Math.min(BATCH.max, Math.max(BATCH.min, limit / 2, Math.min(next, limit * 2))));
      }
    }
  }

  // Works through the queue of pieces, PARALLEL at a time. Pieces that can't be loaded at all are
  // recorded in run.problems (the rest of the window still loads) so they can be retried on their own.
  async function runPieces(run, queue, isCurrent, onProgress, onPiece) {
    const totalDays = daysBetween(run.win.from, run.win.to);
    const active = new Set();
    let fatal = null;

    const status = (msg) => {
      let leads = run.all.sums.leads_with_activity;
      for (const p of active) leads += p.sums.leads_with_activity;
      const where = totalDays > 1 ? `${fmt.format(run.doneDays)} of ${fmt.format(totalDays)} days done · ` : "";
      onProgress(`${where}${fmt.format(leads)} leads loaded${msg ? ` · ${msg}` : ""}`);
    };

    async function worker() {
      while (queue.length && isCurrent() && !fatal) {
        const seg = queue.shift();
        const part = emptyPart();
        active.add(part);
        try {
          await fetchPiece(seg, part, isCurrent, status);
          active.delete(part);
          if (!isCurrent()) return;
          mergePart(run.all, part);
          run.doneDays += daysBetween(seg.from, seg.to);
          onPiece();
        } catch (err) {
          active.delete(part);
          if (!isCurrent()) return;
          if (err.splittable) {
            // Smartlead couldn't handle a range this long: make this and every later piece shorter
            pieceDays = Math.max(1, Math.min(pieceDays, Math.floor(daysBetween(seg.from, seg.to) / 2)));
            const rebuilt = [
              ...splitWindow(seg, pieceDays),
              ...queue.flatMap((s) => (daysBetween(s.from, s.to) > pieceDays ? splitWindow(s, pieceDays) : [s])),
            ];
            queue.length = 0;
            queue.push(...rebuilt);
            status("Smartlead was slow, loading shorter date ranges");
            continue;
          }
          if (err.status === 400) { fatal = err; return; }
          run.problems.push({ from: seg.from, to: seg.to, error: err.message });
          run.doneDays += daysBetween(seg.from, seg.to);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(PARALLEL, queue.length)) }, worker));
    if (fatal) throw fatal;
  }

  function missingText(problems) {
    const labels = problems.map(pieceLabel);
    const list = labels.length > 4 ? `${labels.slice(0, 4).join(", ")} and ${labels.length - 4} more` : labels.join(", ");
    const days = problems.reduce((n, p) => n + daysBetween(p.from, p.to), 0);
    const why = problems[0]?.error ? ` (${problems[0].error.replace(/\.$/, "")})` : "";
    return `Couldn't load ${list} from Smartlead${why}. The numbers below leave out ${days === 1 ? "that day" : `those ${days} days`}.`;
  }

  // ---------- Keep the last result per window in this browser, for instant display ----------
  const CACHE_PREFIX = "sl-report-v3:";
  function readCache(win) {
    try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + winKey(win)) || "null"); } catch { return null; }
  }
  function writeCache(rep) {
    try {
      localStorage.setItem(CACHE_PREFIX + rep.key, JSON.stringify(rep));
    } catch {
      // Storage full: drop other windows and try once more
      try {
        Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_PREFIX + rep.key)
          .forEach((k) => localStorage.removeItem(k));
        localStorage.setItem(CACHE_PREFIX + rep.key, JSON.stringify(rep));
      } catch { /* too large to keep; that's fine */ }
    }
  }

  // ---------- Loading ----------
  // resume: a previous run of the same window; only its missing pieces are fetched again.
  async function load(input, { resume = null } = {}) {
    const { from, to, clipped } = clampWindow(input.from, input.to);
    const win = { from, to };
    current = win;
    const id = ++requestId;
    const isCurrent = () => id === requestId;
    const started = Date.now();
    const resuming = Boolean(resume) && winKey(resume.win) === winKey(win);

    $("from").value = from;
    $("to").value = to;
    $("next-window").disabled = to >= today();
    markPreset(win);
    history.replaceState(null, "", from === to ? `?date=${from}` : `?from=${from}&to=${to}`);
    $("report-title").textContent = titleFor(win);
    $("notice").hidden = true;
    $("refresh").disabled = true;
    if (clipped) showNotice(`Windows can be up to ${MAX_RANGE_DAYS} days, so this one starts on ${shortDate(from)}.`);

    const sumP = rangeTotals(win).catch(() => null);
    let sum = null;
    let drawn = null;
    const draw = (rep) => {
      drawn = rep;
      shown = rep;
      renderSummary(sum, rep, win);
      renderReplyBreakdown(rep);
      renderReplied();
      renderList("clicked", rep.clicked);
      renderList("opened", rep.opened);
    };
    sumP.then((v) => { sum = v; if (isCurrent() && drawn) draw(drawn); });

    // Show the last result for this window straight away, if we have one
    const cached = resuming ? null : readCache(win);
    const cachedAt = cached ? new Date(cached.generated_at).toLocaleTimeString(undefined, { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" }) : null;
    if (resuming && report) {
      draw(report);
    } else if (cached) {
      report = cached;
      draw(cached);
    } else {
      report = null;
      shown = null;
      renderSummary(null, null, win, { loading: true });
      renderReplyBreakdown(null, { loading: true });
      for (const k of ["replied", "clicked", "opened"]) {
        $(`${k}-list`).innerHTML = `<p class="empty">Loading from Smartlead…</p>`;
        $(`${k}-count`).textContent = "";
      }
    }

    // What to fetch: the whole window in pieces, or only the pieces that failed last time
    const run = resuming ? resume : { win, all: emptyPart(), problems: [], doneDays: 0 };
    let queue;
    if (resuming) {
      queue = run.problems.map((p) => ({ from: p.from, to: p.to }));
      run.doneDays -= queue.reduce((n, s) => n + daysBetween(s.from, s.to), 0);
      run.problems = [];
    } else {
      queue = splitWindow(win, pieceDays);
    }

    // Status line with a running timer
    let progressMsg = "";
    const tick = () => {
      if (!isCurrent()) return clearInterval(timer);
      const secs = Math.round((Date.now() - started) / 1000);
      const lead = cached ? `Showing ${cachedAt} results · updating from Smartlead` : resuming ? "Loading missing days" : "Fetching from Smartlead";
      setStatus("loading", `${lead}${progressMsg ? ` · ${progressMsg}` : ""} · ${dur(secs)}`);
    };
    const timer = setInterval(tick, 1000);
    tick();

    try {
      await runPieces(
        run, queue, isCurrent,
        (msg) => { progressMsg = msg; tick(); },
        // Without a cached copy, show results as each piece arrives
        () => { if (isCurrent() && !cached) draw(buildReport(win, run.all)); },
      );
      if (!isCurrent()) return;

      const totalDays = daysBetween(from, to);
      const missingDays = run.problems.reduce((n, p) => n + daysBetween(p.from, p.to), 0);
      if (missingDays >= totalDays) throw new Error(run.problems[0]?.error || "Smartlead didn't return any data.");

      sum = await sumP;
      const rep = buildReport(win, run.all);
      rep.missing = run.problems.map((p) => ({ from: p.from, to: p.to }));
      report = rep;
      draw(rep);

      const at = new Date(rep.generated_at).toLocaleTimeString(undefined, { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });
      const took = dur(Math.round((Date.now() - started) / 1000));
      if (rep.missing.length) {
        setStatus("error", `${windowLabel(win)} · live from Smartlead at ${at} IST (took ${took}) · some days missing`);
        showNotice(missingText(run.problems), { retry: true, retryLabel: "Load missing days", onRetry: () => load(win, { resume: run }) });
      } else {
        writeCache(rep);
        setStatus("live", `${windowLabel(win)} · live from Smartlead at ${at} IST (took ${took})`);
      }
    } catch (err) {
      if (!isCurrent()) return;
      const why = err.status === 504 || err.status === 502 ? "Smartlead isn't responding right now." : err.message;
      if (resuming && report) {
        setStatus("error", `${windowLabel(win)} · some days missing`);
        showNotice(`Couldn't load the missing days: ${why}`, { retry: true, retryLabel: "Try again", onRetry: () => load(win, { resume: run }) });
      } else if (cached) {
        setStatus("error", `${windowLabel(win)} · showing results from ${cachedAt}`);
        showNotice(`Couldn't update from Smartlead: ${why}`, { retry: true });
      } else {
        report = null;
        shown = null;
        renderSummary(await sumP, null, win);
        renderReplyBreakdown(null);
        setStatus("error", windowLabel(win));
        showNotice(`Couldn't load the lead lists: ${why}`, { retry: true });
        for (const k of ["replied", "clicked", "opened"]) $(`${k}-list`).innerHTML = `<p class="empty">Not available.</p>`;
      }
    } finally {
      clearInterval(timer);
      if (isCurrent()) $("refresh").disabled = false;
    }
  }

  function showNotice(text, { retry = false, retryLabel = "Try again", onRetry = () => load(current) } = {}) {
    const el = $("notice");
    el.textContent = text;
    if (retry) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "link-btn";
      btn.style.marginLeft = "0.5rem";
      btn.textContent = retryLabel;
      btn.addEventListener("click", onRetry);
      el.append(btn);
    }
    el.hidden = false;
  }

  // ---------- Rendering ----------
  function renderSummary(sum, rep, win, { loading = false } = {}) {
    const days = daysBetween(win.from, win.to);
    const span = days === 1
      ? "12:00 AM to 12:00 AM India time"
      : `12:00 AM ${shortDate(win.from)} to 12:00 AM ${shortDate(addDays(win.to, 1))} India time (${days} days)`;

    if (loading) {
      $("summary").innerHTML = ["Emails sent", "Leads opened", "Leads clicked", "Replies", "Positive replies", "Negative replies", "Bounced", "Unsubscribed"]
        .map((l) => `<div><dt>${l}</dt><dd class="pending">…</dd></div>`).join("");
      $("summary-note").textContent = `Counted from ${span}.`;
      renderSteps(null, { loading: true });
      return;
    }

    const t = sum?.totals;
    const c = rep?.counts;
    const item = (label, value, sub = "") =>
      `<div><dt>${label}</dt><dd>${value == null ? "–" : fmt.format(value)}${sub ? `<small>${sub}</small>` : ""}</dd></div>`;

    // Exact, from Smartlead's timestamps within the window
    const sent = c?.sent_in_window;
    const leads = c?.leads_sent_in_window;
    const replies = c?.replies_in_window ?? c?.replied;
    const g = c?.reply_groups;
    const repliedLeads = c?.replied;
    // Opens/clicks: midnight-to-midnight snapshots when available, otherwise leads in the lists below
    const opened = t ? t.unique_opened : c?.opened;
    const clicked = t ? t.clicked : c?.clicked;

    const steps = stepBreakdown(rep, t);
    lastSummary = { sent, steps };

    $("summary").innerHTML =
      item("Emails sent", sent, leads != null ? `${fmt.format(leads)} leads` : "") +
      item(t ? "Opened" : "Leads opened", opened, pctOf(opened, t ? t.unique_sent : leads)) +
      item(t ? "Clicked" : "Leads clicked", clicked) +
      item("Replies", replies, pctOf(replies, leads)) +
      item("Positive replies", g ? g.positive : null, g ? pctOf(g.positive, repliedLeads) : "") +
      item("Negative replies", g ? g.negative : null, g ? pctOf(g.negative, repliedLeads) : "") +
      item("Bounced", t ? t.bounced : null, t ? pctOf(t.bounced, t.sent) : "") +
      item("Unsubscribed", t ? t.unsubscribed : null);

    renderSteps(steps);

    const notes = [`Counted from ${span}${win.to === today() ? " (today is still in progress)" : ""}.`];
    if (g) notes.push("Positive and negative count each lead who replied once, by their latest reply; percentages are of leads who replied.");
    if (!t) notes.push("Opens and clicks are counted from the lead lists below, and bounces aren't available, because this window doesn't start and end on midnight snapshots.");
    $("summary-note").textContent = notes.join(" ");
  }

  function renderReplyBreakdown(rep, { loading = false } = {}) {
    const el = $("reply-breakdown");
    const c = rep?.counts;
    const has = Boolean(c) && !loading;
    const total = has ? c.replied || 0 : 0;
    const groups = (has && c.reply_groups) || {};
    const cats = (has && c.reply_categories) || {};
    const num = (v) => (loading ? `<span class="pending">…</span>` : v == null ? "–" : fmt.format(v));

    const cards = REPLY_GROUPS.map((g) => {
      const n = has ? groups[g.key] || 0 : null;
      return `
        <button type="button" class="reply-card" data-group="${g.key}" data-filter="${g.key}" aria-pressed="${replyFilter === g.key}">
          <span class="reply-card-label">${esc(g.label)}</span>
          <span class="reply-card-num">${num(n)}</span>
          <span class="reply-card-sub">${has && total ? `${pctOf(n, total)} of leads who replied` : ""}</span>
        </button>`;
    }).join("");

    const rows = REPLY_GROUPS.flatMap((g) => g.cats.map((k) => {
      const n = has ? cats[k] || 0 : null;
      return `
        <tr>
          <th scope="row" class="text">${esc(CAT_LABELS[k])}</th>
          <td class="text"><span class="tag" data-group="${g.key}">${esc(g.label)}</span></td>
          <td>${num(n)}</td>
          <td class="rate">${has ? pctOf(n, total) : ""}</td>
        </tr>`;
    })).join("");

    const note = !has ? "" : total
      ? `Each lead is counted once, by their latest reply in this window. ${fmt.format(c.auto_replies || 0)} of ${fmt.format(total)} were automatic (out of office, vacation, bounces).`
      : "No replies in this window.";

    el.innerHTML = `
      <div class="reply-cards">${cards}</div>
      <div class="table-scroll">
        <table class="step-table reply-table">
          <thead>
            <tr>
              <th scope="col" class="text">Category</th>
              <th scope="col" class="text">Group</th>
              <th scope="col">Leads</th>
              <th scope="col">% of replies</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <th scope="row" class="text">All replies</th>
              <td></td>
              <td>${num(has ? total : null)}</td>
              <td class="rate">${has && total ? "100%" : ""}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="panel-sub breakdown-note">${esc(note)}</p>`;
  }

  function filterReplies(rows) {
    if (replyFilter === "all") return rows;
    if (GROUP_LABEL[replyFilter]) return rows.filter((r) => groupOf(r) === replyFilter);
    return rows.filter((r) => catOf(r) === replyFilter);
  }

  function setReplyFilter(v) {
    replyFilter = v || "all";
    $("reply-filter").value = replyFilter;
    document.querySelectorAll("#reply-breakdown .reply-card")
      .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === replyFilter)));
    renderReplied();
  }

  function renderReplied() {
    if (!shown) return;
    const all = shown.replied || [];
    const rows = filterReplies(all);
    const filtered = replyFilter !== "all" && all.length > 0;
    const uniq = (list) => new Set(list.map((r) => r.lead_id)).size;
    renderList("replied", rows, {
      count: filtered ? `(${fmt.format(uniq(rows))} of ${fmt.format(uniq(all))})` : null,
      empty: filtered ? "No replies match this filter." : null,
    });
  }

  // ---------- Per-step breakdown (E1, E2, …) ----------
  // E1–E4 are always shown; later steps (E5, E6, …) appear when there's something to show for them.
  function stepBreakdown(rep, t) {
    const c = rep?.counts;
    const uniqBy = (rows) => {
      const by = {};
      for (const r of rows || []) (by[stepKey(r.seq)] ||= new Set()).add(r.lead_id);
      return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.size]));
    };
    const touched = c?.touched_by_step || {};
    const opened = uniqBy(rep?.opened);
    const clicked = uniqBy(rep?.clicked);
    const replies = c?.replies_by_step || uniqBy(rep?.replied);
    const keys = new Set(["1", "2", "3", "4", ...[touched, opened, clicked, replies].flatMap(Object.keys)]);
    const has = Boolean(c);

    const rows = [...keys]
      .sort((a, b) => (Number(a) || 999) - (Number(b) || 999))
      .map((k) => ({
        key: k,
        label: k === "?" ? "Unknown step" : `E${k}`,
        touched: has ? touched[k] || 0 : null,
        opened: has ? opened[k] || 0 : null,
        clicked: has ? clicked[k] || 0 : null,
        replies: has ? replies[k] || 0 : null,
        bounced: null,
        unsubscribed: null,
      }));

    const total = {
      key: "all",
      label: "All steps",
      touched: c?.leads_sent_in_window ?? null,
      opened: c?.opened ?? null,
      clicked: c?.clicked ?? null,
      replies: c ? c.replies_in_window ?? c.replied ?? null : null,
      bounced: t ? t.bounced : null,
      unsubscribed: t ? t.unsubscribed : null,
    };
    return { total, rows };
  }

  function stepKey(seq) {
    return String(Number(seq) || "?");
  }

  function renderSteps(steps, { loading = false } = {}) {
    const el = $("steps");
    const num = (v) => (loading ? `<span class="pending">…</span>` : v == null ? "–" : fmt.format(v));
    const rate = (n, d) => (loading ? "" : pctOf(n, d));
    const data = loading
      ? { total: { label: "All steps" }, rows: [1, 2, 3, 4].map((n) => ({ label: `E${n}` })) }
      : steps;

    const tr = (r, isTotal = false) => `
      <tr${isTotal ? ' class="total"' : ""}>
        <th scope="row" class="text">${esc(r.label)}</th>
        <td>${num(r.touched)}</td>
        <td class="k-opened">${num(r.opened)}</td>
        <td class="rate">${rate(r.opened, r.touched)}</td>
        <td class="k-replied">${num(r.replies)}</td>
        <td class="rate">${rate(r.replies, r.touched)}</td>
      </tr>`;

    el.innerHTML = `
      <div class="table-scroll">
        <table class="step-table">
          <thead>
            <tr>
              <th scope="col" class="text">Step</th>
              <th scope="col">Emails touched</th>
              <th scope="col" class="k-opened">Opened</th>
              <th scope="col">Open rate</th>
              <th scope="col" class="k-replied">Replies</th>
              <th scope="col">Reply rate</th>
            </tr>
          </thead>
          <tbody>${data.rows.map((r) => tr(r)).join("")}</tbody>
          <tfoot>${tr(data.total, true)}</tfoot>
        </table>
      </div>`;
  }

  function renderList(kind, rows, { count = null, empty = null } = {}) {
    $(`${kind}-count`).textContent = count ?? (rows.length ? `(${fmt.format(new Set(rows.map((r) => r.lead_id)).size)})` : "");
    const el = $(`${kind}-list`);
    if (!rows.length) {
      el.innerHTML = `<p class="empty">${esc(empty || { replied: "No replies in this window.", clicked: "No clicks in this window.", opened: "No opens in this window." }[kind])}</p>`;
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
    const k = kind === "replied" ? catOf(r) : null;
    const catChip = k ? `<span class="chip cat" data-group="${GROUP_OF[k]}">${esc(CAT_LABELS[k])}</span>` : "";
    const source = k && SOURCE_LABEL[r.reply_category_source] ? ` (${SOURCE_LABEL[r.reply_category_source]})` : "";
    const links = r.links?.length
      ? `<div class="block"><h3>Links clicked</h3><ul>${r.links.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>` : "";
    const reply = r.reply_text != null
      ? `<div class="block reply"><h3>Their reply · ${esc(timeIST(r.reply_time))} · ${esc(CAT_LABELS[k])}${esc(source)}</h3><div class="body">${esc(r.reply_text) || "<em>No text</em>"}</div></div>` : "";
    return `
      <details class="lead" data-kind="${kind}">
        <summary>
          <span class="who">
            <strong>${esc(r.lead_email || `Lead ${r.lead_id}`)}</strong>
            <span class="meta">${esc(r.campaign_name)}${r.seq != null ? `, step ${esc(r.seq)}` : ""}</span>
          </span>
          <span class="subject">${esc(r.subject) || "<em>No subject</em>"}</span>
          <span class="chips">${catChip}<span class="chip">${esc(chip)}</span></span>
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

  // ---------- CSV export ----------
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
      if (r.reply_time) {
        Object.assign(row, {
          reply_time: r.reply_time, reply_text: r.reply_text,
          reply_category: r.reply_category, reply_category_source: r.reply_category_source,
        });
      }
      byKey.set(key, row);
    };
    [...report.replied, ...report.clicked, ...report.opened].forEach(add);
    const rows = [...byKey.values()].sort((a, b) =>
      (b.reply_time ? 1 : 0) - (a.reply_time ? 1 : 0) ||
      (a.reply_time && b.reply_time ? GROUP_RANK[groupOf(a)] - GROUP_RANK[groupOf(b)] : 0) ||
      b.clicks - a.clicks || b.opens - a.opens);

    const win = { from: report.from_date, to: report.to_date };
    const c = report.counts || {};
    const total = c.replied || 0;
    const groups = c.reply_groups || {};
    const cats = c.reply_categories || {};
    const ofReplied = (n) => (total ? `${pctOf(n, total)} of leads who replied` : "");
    const sum = lastSummary || { sent: c.sent_in_window, steps: stepBreakdown(report, null) };
    const stepLine = (label, r) => line([label, r.touched, r.opened, r.clicked, r.replies, r.bounced, r.unsubscribed]);
    const missing = report.missing || [];

    const out = [
      line(["Smartlead report"]),
      line(["Window", windowLabel(win)]),
      line(["From (IST)", ist(report.from)]),
      line(["To (IST)", ist(report.to)]),
      line(["Days", daysBetween(win.from, win.to)]),
      ...(missing.length ? [line(["Days not loaded", missing.map(pieceLabel).join(", ")])] : []),
      line(["Exported at (IST)", ist(new Date().toISOString())]),
      "",
      line(["Metric", "Value", "Note"]),
      line(["Emails sent", sum.sent, "exact, from send timestamps"]),
      line(["Replies received", c.replies_in_window, "reply messages in the window"]),
      line(["Leads who replied", total, "unique leads"]),
      line(["Positive replies", groups.positive || 0, ofReplied(groups.positive || 0)]),
      line(["Negative replies", groups.negative || 0, ofReplied(groups.negative || 0)]),
      line(["Needs review", groups.review || 0, ofReplied(groups.review || 0)]),
      line(["Automatic replies", c.auto_replies || 0, "out of office, vacation and bounces (included in Negative)"]),
      "",
      line(["Reply group", "Reply category", "Leads", "% of leads who replied"]),
      ...REPLY_GROUPS.flatMap((g) => [
        line([g.label, "All", groups[g.key] || 0, pctOf(groups[g.key] || 0, total)]),
        ...(g.key === "review" ? [] : g.cats.map((k) => line([g.label, CAT_LABELS[k], cats[k] || 0, pctOf(cats[k] || 0, total)]))),
      ]),
      "",
      line(["", "Total Count", "Leads opened", "Leads clicked", "Replies", "Bounced", "Unsubscribed"]),
      stepLine("Unique emails touched", sum.steps.total),
      ...sum.steps.rows.map((r) => stepLine(`Unique emails touched · ${r.label}`, r)),
      "",
      "",
      line([
        "Engagement", "Reply group", "Reply category", "Lead email", "Lead status", "Campaign", "Campaign ID", "Sequence step", "Subject",
        "Sent from", "Sent at (IST)", "Sent in this window", "Opened", "Opens", "Clicked", "Clicks", "Links clicked",
        "Replied", "Replied at (IST)", "Category source", "Reply text", "Email we sent",
      ]),
      ...rows.map((r) => line([
        r.reply_time ? "Replied" : r.clicks > 0 ? "Clicked" : "Opened",
        r.reply_time ? GROUP_LABEL[groupOf(r)] : "",
        r.reply_time ? CAT_LABELS[catOf(r)] : "",
        r.lead_email, r.lead_status, r.campaign_name, r.campaign_id, r.seq, r.subject,
        r.from_email, ist(r.sent_time), r.sent_in_window ? "Yes" : "No",
        r.opens > 0 ? "Yes" : "No", r.opens, r.clicks > 0 ? "Yes" : "No", r.clicks, (r.links || []).join(" | "),
        r.reply_time ? "Yes" : "No", ist(r.reply_time),
        r.reply_time ? SOURCE_LABEL[r.reply_category_source] || "" : "",
        r.reply_text || "", r.body || "",
      ])),
    ];

    const name = win.from === win.to ? `smartlead-report-${win.from}.csv` : `smartlead-report-${win.from}_to_${win.to}.csv`;
    download(name, out.join("\r\n"));
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
  // Results cached by older versions have different categories
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("sl-report:") || k.startsWith("sl-report-v2:"))
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }

  $("reply-filter").innerHTML =
    `<option value="all">All replies</option>` +
    REPLY_GROUPS.map((g) => `<option value="${g.key}">${esc(g.label)} (all)</option>`).join("") +
    REPLY_GROUPS.filter((g) => g.key !== "review").map((g) =>
      `<optgroup label="${esc(g.label)}">${g.cats.map((k) => `<option value="${k}">${esc(CAT_LABELS[k])}</option>`).join("")}</optgroup>`
    ).join("");
  $("reply-filter").addEventListener("change", (e) => setReplyFilter(e.target.value));
  $("reply-breakdown").addEventListener("click", (e) => {
    const card = e.target.closest(".reply-card");
    if (!card) return;
    setReplyFilter(replyFilter === card.dataset.filter ? "all" : card.dataset.filter);
    $("replied-title").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.querySelectorAll("[data-preset]").forEach((b) =>
    b.addEventListener("click", () => load(PRESETS[b.dataset.preset]())));
  $("range-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = $("from").value;
    const t = $("to").value;
    if (isDate(f) && isDate(t)) load({ from: f, to: t });
  });
  $("prev-window").addEventListener("click", () => {
    const n = daysBetween(current.from, current.to);
    load({ from: addDays(current.from, -n), to: addDays(current.from, -1) });
  });
  $("next-window").addEventListener("click", () => {
    const n = daysBetween(current.from, current.to);
    load({ from: addDays(current.to, 1), to: addDays(current.to, n) });
  });
  $("export-csv").addEventListener("click", exportCsv);
  $("refresh").addEventListener("click", () => load(current));
  $("from").max = today();
  $("to").max = today();

  const params = new URLSearchParams(location.search);
  const qDate = params.get("date");
  const qFrom = params.get("from");
  const qTo = params.get("to");
  const y = addDays(today(), -1);
  const initial = isDate(qFrom) && isDate(qTo) ? { from: qFrom, to: qTo }
    : isDate(qDate) ? { from: qDate, to: qDate }
    : { from: y, to: y };
  load(initial);
})();
