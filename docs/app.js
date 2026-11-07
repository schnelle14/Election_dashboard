(() => {
  "use strict";

  const DATA_URL = "data/electorates.json";
  const PARL_URL = "data/parliament.json";
  // Blocs = the outgoing (2023-26) government and opposition, plus a possible
  // opposition + Opportunity grouping. Not predictions of coalitions.
  const BLOCS = [
    { name: "Outgoing government", parties: ["National", "ACT", "NZ First"] },
    { name: "Outgoing opposition", parties: ["Labour", "Greens", "Te Pāti Māori"] },
    { name: "Opposition + Opportunity", parties: ["Labour", "Greens", "Te Pāti Māori", "Opportunity"], possible: true },
  ];
  const REFRESH_MS = 2 * 60 * 1000;
  // "Close" depends on how much is left to count: a lead is close if the
  // runner-up could overturn it by winning the uncounted votes by CLOSE_SWING
  // more than the leader, plus a floor for special votes counted later.
  const EST_VOTES_PER_ELECTORATE = 35000; // rough: ~45k enrolled x ~78% turnout
  const CLOSE_SWING = 0.05;
  const CLOSE_FLOOR = 300;
  const closeThreshold = (e) => Math.round(
    CLOSE_FLOOR + CLOSE_SWING * EST_VOTES_PER_ELECTORATE * (1 - Math.min(100, Math.max(0, e.percentCounted)) / 100));
  const isClose = (e) => e.margin != null && e.margin < closeThreshold(e);
  const STALE_MS = 10 * 60 * 1000;
  const RING_C = 2 * Math.PI * 7; // countdown ring circumference (r = 7)

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat("en-NZ");
  const timeFmt = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland", hour: "numeric", minute: "2-digit", day: "numeric", month: "short",
  });

  const state = {
    data: null,
    parl: null,
    prevLeaders: null,      // slug -> party, from the previous fetch
    flipped: new Set(),     // slugs whose leading party changed since page load
    changedSlugs: new Set(),
    search: "",
    party: "",
    view: "all",
    sort: { key: "name", dir: 1 },
    lastFetchOk: null,
    nextRefreshAt: Date.now() + REFRESH_MS,
  };

  // ---- persistence of UI choices (per viewer convenience only) ----
  const PREFS_KEY = "nz-electorate-dashboard-prefs";
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (p.view) state.view = p.view;
    if (p.sort && p.sort.key) state.sort = p.sort;
  } catch (_) { /* storage unavailable */ }
  const savePrefs = () => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ view: state.view, sort: state.sort })); } catch (_) {}
  };

  // ---- motion -------------------------------------------------------------
  // Before a container re-renders we snapshot its keyed elements ([data-k]);
  // afterwards bars ([data-w], a width %) slide and numbers ([data-n] with a
  // data-fmt) roll from their old values, and changed values get a brief
  // green/red tint. Nothing moves when the viewer prefers reduced motion.
  const REDUCED = (() => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } })();
  const FORMATS = { int: (v) => fmt.format(Math.round(v)), pct1: (v) => `${v.toFixed(1)}%` };

  function snap(container) {
    const m = new Map();
    container.querySelectorAll("[data-k]").forEach((el) => m.set(el.dataset.k, { w: el.dataset.w, n: el.dataset.n }));
    return m;
  }

  function growWidth(el, from, to, delay) {
    el.style.transition = "none";
    el.style.width = `${from}%`;
    void el.offsetWidth; // commit the start width before transitioning
    el.style.transition = "";
    el.style.transitionDelay = delay ? `${delay}ms` : "";
    el.style.width = `${to}%`;
  }

  function tween(el, from, to, format, ms = 600) {
    cancelAnimationFrame(el._raf);
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = format(from + (to - from) * eased);
      if (t < 1) el._raf = requestAnimationFrame(step);
    };
    el.textContent = format(from);
    el._raf = requestAnimationFrame(step);
  }

  function bump(el, dir) {
    el.classList.remove("bump-up", "bump-down");
    void el.offsetWidth; // restart the animation
    el.classList.add(`bump-${dir}`);
  }

  // Render into `container` with motion. First render of a container sweeps
  // bars and counters in from zero (staggered); later renders animate deltas.
  function withMotion(container, render) {
    const first = !container.dataset.rendered;
    const before = snap(container);
    render();
    container.dataset.rendered = "1";
    if (REDUCED) return;
    let i = 0;
    container.querySelectorAll("[data-k]").forEach((el) => {
      const prev = before.get(el.dataset.k);
      if (el.dataset.w != null) {
        const to = Number(el.dataset.w);
        const from = prev ? Number(prev.w) : first ? 0 : to;
        if (from !== to) growWidth(el, from, to, first ? Math.min(i++, 12) * 35 : 0);
      }
      if (el.dataset.n != null) {
        const to = Number(el.dataset.n);
        const from = prev ? Number(prev.n) : first && el.dataset.fmt ? 0 : to;
        if (from !== to) {
          if (el.dataset.fmt) tween(el, from, to, FORMATS[el.dataset.fmt]);
          if (prev) bump(el, to > from ? "up" : "down");
        }
      }
    });
  }

  function announceUpdate() {
    const t = $("update-toast");
    if (!t || REDUCED) return;
    t.hidden = false;
    t.classList.remove("show");
    void t.offsetWidth;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const relTime = (ms) => {
    const s = Math.round(ms / 1000);
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return `${h} hr ago`;
  };
  const partyName = (e) => e.party || (e.isIndependent ? "Independent" : "Unknown");

  // ---- data loading ----
  async function load({ manual = false } = {}) {
    const btn = $("refresh-btn");
    btn.disabled = true;
    try {
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data.electorates)) throw new Error("unexpected data format");
      ingest(data);
      state.lastFetchOk = Date.now();
      $("error").hidden = true;
      await loadParliament();
    } catch (err) {
      $("error").hidden = false;
      $("error").textContent = state.data
        ? `Couldn't check for new results (${err.message}). Showing the last data loaded; retrying automatically.`
        : `Couldn't load results (${err.message}). Retrying automatically.`;
    } finally {
      btn.disabled = false;
      state.nextRefreshAt = Date.now() + REFRESH_MS;
      if (manual) btn.blur();
      renderStatus();
    }
  }

  // Seats in Parliament come from a second file. A failure here must not
  // take down the electorate view, so it is handled on its own.
  async function loadParliament() {
    try {
      const res = await fetch(`${PARL_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parl = await res.json();
      if (!Array.isArray(parl.parties)) throw new Error("unexpected data format");
      const changed = state.parl && JSON.stringify(state.parl.parties) !== JSON.stringify(parl.parties);
      state.parl = parl;
      renderParliament();
      if (changed) announceUpdate();
    } catch (err) {
      if (!state.parl) $("parl-sub").textContent = `Seat projection unavailable right now (${err.message}).`;
    }
  }

  function ingest(data) {
    const leaders = {};
    const sigs = {};
    data.electorates.forEach((e) => {
      leaders[e.slug] = partyName(e);
      sigs[e.slug] = `${e.percentCounted}|${e.margin}|${e.candidate}`;
    });
    state.changedSlugs = new Set();
    if (state.prevLeaders) {
      for (const [slug, party] of Object.entries(leaders)) {
        if (state.prevLeaders[slug] && state.prevLeaders[slug] !== party) state.flipped.add(slug);
        if (state.prevSigs && state.prevSigs[slug] !== sigs[slug]) state.changedSlugs.add(slug);
      }
    }
    const hadData = !!state.data;
    state.prevLeaders = leaders;
    state.prevSigs = sigs;
    state.data = data;
    renderAll();
    if (hadData && state.changedSlugs.size) announceUpdate();
    // Row highlights are one-shot: don't replay them when filters re-render.
    state.changedSlugs = new Set();
  }

  // ---- rendering ----
  function renderAll() {
    renderMeta();
    renderTiles();
    renderBars();
    renderPartyFilter();
    renderTable();
  }

  function signed(n, digits = 0) {
    if (n == null || Number.isNaN(n)) return "—";
    const v = Number(n);
    const abs = Math.abs(v).toFixed(digits);
    return v > 0 ? `+${abs}` : v < 0 ? `−${abs}` : (0).toFixed(digits);
  }

  function renderParliament() {
    const P = state.parl;
    const total = P.totalSeats;
    const seated = P.parties.filter((p) => p.seatsTotal > 0);
    const byName = Object.fromEntries(P.parties.map((p) => [p.name, p]));
    const updated = P.sourceUpdatedAt ? ` · updated ${timeFmt.format(new Date(P.sourceUpdatedAt))}` : "";
    $("parl-sub").textContent =
      `Projected from the party vote (${P.percentCounted ?? "?"}% counted) · ${total} seats` +
      `${P.overhangSeats ? ` including ${P.overhangSeats} overhang` : ""} · ${P.majority} needed to govern${updated}`;
    $("house-mid-label").textContent = `${P.majority} for a majority`;

    // Seat strip in RNZ's seating order (left to right).
    const ordered = seated.slice().sort((a, b) => (a.seatingOrder ?? 999) - (b.seatingOrder ?? 999) || a.name.localeCompare(b.name));
    const house = $("house");
    withMotion(house, () => {
      house.innerHTML = ordered.map((p) => `<div class="house-seg" role="listitem" tabindex="0" data-party="${esc(p.name)}"
          data-k="seg:${esc(p.name)}" data-w="${(p.seatsTotal / total) * 100}" data-n="${p.seatsTotal}"
          style="width:${(p.seatsTotal / total) * 100}%;background:${esc(p.colour)}"
          aria-label="${esc(p.name)}: ${p.seatsTotal} seats"></div>`).join("");
    });
    const houseKey = $("house-key");
    withMotion(houseKey, () => {
      houseKey.innerHTML = ordered.map((p) =>
        `<span><span class="swatch" style="background:${esc(p.colour)}"></span>${esc(p.name)} <strong data-k="key:${esc(p.name)}" data-n="${p.seatsTotal}" data-fmt="int">${p.seatsTotal}</strong></span>`).join("");
    });
    house.querySelectorAll(".house-seg").forEach((seg) => {
      const p = byName[seg.dataset.party];
      bindTooltip(seg, `<strong>${esc(p.name)} · ${p.seatsTotal} seats</strong>
        <div class="tt-row">${p.seatsElectorate} electorate + ${p.seatsList} list</div>
        <div class="tt-row">${p.percentPartyVotes.toFixed(1)}% of the party vote</div>
        <div class="tt-row">${signed(p.seatsChange)} seats vs 2023</div>`);
    });

    // Blocs vs the majority line.
    const scaleMax = Math.max(P.majority * 1.25, ...BLOCS.map((b) => b.parties.reduce((a, n) => a + (byName[n]?.seatsTotal || 0), 0)));
    const inBloc = new Set(BLOCS.flatMap((b) => b.parties));
    const others = seated.filter((p) => !inBloc.has(p.name));
    const blocsEl = $("blocs");
    withMotion(blocsEl, () => { blocsEl.innerHTML = BLOCS.map((b) => {
      const members = b.parties.map((n) => byName[n]).filter(Boolean);
      const seats = members.reduce((a, p) => a + p.seatsTotal, 0);
      const diff = seats - P.majority;
      const verdict = diff > 0 ? `majority, ${diff} to spare` : diff === 0 ? "bare majority" : `${-diff} short of a majority`;
      return `<div class="bloc">
        <div class="bloc-head">
          <span><span class="bloc-name">${esc(b.name)}</span>${b.possible ? ` <span class="bloc-tag">possible</span>` : ""} <span class="bloc-parties">${esc(b.parties.join(" + "))}</span></span>
          <span class="bloc-total"><strong data-k="blocn:${esc(b.name)}" data-n="${seats}" data-fmt="int">${seats}</strong> seats · ${verdict}</span>
        </div>
        <div class="bloc-track" role="img" aria-label="${esc(b.name)}: ${seats} seats, ${verdict}">
          ${members.filter((p) => p.seatsTotal > 0).map((p) => `<span class="bloc-seg" data-k="bloc:${esc(b.name)}:${esc(p.name)}" data-w="${(p.seatsTotal / scaleMax) * 100}" style="width:${(p.seatsTotal / scaleMax) * 100}%;background:${esc(p.colour)}"></span>`).join("")}
          <span class="bloc-line" style="left:${(P.majority / scaleMax) * 100}%"></span>
        </div>
      </div>`;
    }).join("") + (others.length
      ? `<p class="bloc-others">Not in any bloc: ${others.map((p) => `${esc(p.name)} ${p.seatsTotal}`).join(", ")}</p>` : "");
    });

    // Party table: parties with seats or shown by default, then the rest summed.
    const shown = P.parties.filter((p) => p.seatsTotal > 0 || p.isShownByDefault);
    const rest = P.parties.filter((p) => !shown.includes(p));
    const restPct = rest.reduce((a, p) => a + p.percentPartyVotes, 0);
    const parlRows = $("parl-rows");
    withMotion(parlRows, () => { parlRows.innerHTML = shown.map((p) => `<tr class="${p.seatsTotal ? "" : "muted"}">
        <td><span class="p-name"><span class="swatch" style="background:${esc(p.colour)}"></span>${esc(p.name)}</span></td>
        <td class="num"><span data-k="pv:${esc(p.name)}" data-n="${p.percentPartyVotes}" data-fmt="pct1">${p.percentPartyVotes.toFixed(1)}%</span> <span class="chg">${signed(p.percentPartyVotesChange, 1)}</span></td>
        <td class="num col-detail"><span data-k="pe:${esc(p.name)}" data-n="${p.seatsElectorate}" data-fmt="int">${p.seatsElectorate}</span></td>
        <td class="num col-detail"><span data-k="pl:${esc(p.name)}" data-n="${p.seatsList}" data-fmt="int">${p.seatsList}</span></td>
        <td class="num p-total"><span data-k="pt:${esc(p.name)}" data-n="${p.seatsTotal}" data-fmt="int">${p.seatsTotal}</span></td>
        <td class="num chg">${signed(p.seatsChange)}</td>
      </tr>`).join("") + (rest.length ? `<tr class="muted">
        <td>Other parties (${rest.length})</td><td class="num">${restPct.toFixed(1)}%</td>
        <td class="num col-detail">0</td><td class="num col-detail">0</td><td class="num">0</td><td></td></tr>` : "");
    });
  }

  function renderMeta() {
    const d = state.data;
    const parts = [];
    if (d.sourceUpdatedAt) parts.push(`RNZ results updated ${timeFmt.format(new Date(d.sourceUpdatedAt))}`);
    if (d.scrapedAt) parts.push(`numbers last changed ${timeFmt.format(new Date(d.scrapedAt))}`);
    $("meta").textContent = parts.join(" · ");
  }

  function renderStatus() {
    const dot = $("live-dot");
    const txt = $("status-text");
    if (!state.data) { txt.textContent = "Loading…"; return; }
    const src = state.data.sourceUpdatedAt ? Date.parse(state.data.sourceUpdatedAt) : null;
    const stale = src && Date.now() - src > STALE_MS;
    dot.className = "dot " + (stale ? "stale" : "live");
    $("live-label").textContent = stale ? "Waiting" : "Live";
    $("live-pill").classList.toggle("is-stale", !!stale);
    const ring = $("countdown-arc");
    if (ring) {
      const left = Math.max(0, Math.min(1, (state.nextRefreshAt - Date.now()) / REFRESH_MS));
      ring.style.strokeDashoffset = String(RING_C * (1 - left));
    }
    const secs = Math.max(0, Math.round((state.nextRefreshAt - Date.now()) / 1000));
    const mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, "0");
    const checked = state.lastFetchOk ? `Checked ${relTime(Date.now() - state.lastFetchOk)}` : "Not checked yet";
    txt.textContent = `${checked} · next check in ${mm}:${ss}`;
  }

  function renderTiles() {
    const list = state.data.electorates;
    const n = list.length;
    const avg = n ? list.reduce((a, e) => a + e.percentCounted, 0) / n : 0;
    const done = list.filter((e) => e.percentCounted >= 100).length;
    const withMargin = list.filter((e) => e.margin != null);
    const close = withMargin.filter(isClose);
    const closest = withMargin.slice().sort((a, b) => a.margin - b.margin)[0];

    withMotion(document.querySelector(".tiles"), () => {
      const setNum = (id, v, f, text) => { const el = $(id); el.dataset.k = id; el.dataset.n = v; el.dataset.fmt = f; el.textContent = text; };
      setNum("t-count", n, "int", String(n));
      setNum("t-avg", Math.round(avg * 10) / 10, "pct1", `${avg.toFixed(1)}%`);
      setNum("t-close", close.length, "int", String(close.length));
    });
    $("t-count-sub").textContent = `${done} fully counted`;
    $("t-avg-sub").textContent = "simple average across electorates";
    if (closest) {
      $("t-closest").textContent = closest.name;
      $("t-closest").title = closest.name;
      $("t-closest-sub").textContent = `${partyName(closest)} ahead by ${fmt.format(closest.margin)}`;
    }
  }

  function partyStats() {
    const map = new Map();
    for (const e of state.data.electorates) {
      const name = partyName(e);
      if (!map.has(name)) map.set(name, { name, colour: e.colour, count: 0, maori: 0, close: 0, done: 0 });
      const p = map.get(name);
      p.count++;
      if (e.isMaori) p.maori++;
      if (e.percentCounted >= 100) p.done++;
      if (isClose(e)) p.close++;
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  // Heading follows the count: "led" until an electorate is fully counted,
  // "won" once every electorate is, "led or won" in between.
  function barsHeading() {
    const list = state.data.electorates;
    const done = list.filter((e) => e.percentCounted >= 100).length;
    if (done === 0) return "Electorates led, by party";
    if (done === list.length) return "Electorates won, by party";
    return "Electorates led or won, by party";
  }

  function renderBars() {
    const stats = partyStats();
    $("seats-h").textContent = barsHeading();
    const max = Math.max(1, ...stats.map((p) => p.count));
    const el = $("party-bars");
    withMotion(el, () => { el.innerHTML = stats.map((p) => `
      <div class="bar-row" role="listitem" tabindex="0" data-party="${esc(p.name)}"
           aria-label="${esc(p.name)}: ${p.count} electorates, ${p.done} fully counted">
        <span class="bar-label"><span class="swatch" style="background:${esc(p.colour)}"></span>${esc(p.name)}</span>
        <span class="bar-track"><span class="bar-fill" data-k="bar:${esc(p.name)}" data-w="${(p.count / max) * 100}" style="width:${(p.count / max) * 100}%;background:${esc(p.colour)}"></span></span>
        <span class="bar-value" data-k="barv:${esc(p.name)}" data-n="${p.count}" data-fmt="int">${p.count}</span>
      </div>`).join(""); });
    el.querySelectorAll(".bar-row").forEach((row) => {
      const p = stats.find((s) => s.name === row.dataset.party);
      const html = `<strong>${esc(p.name)}</strong>
        <div class="tt-row">${[p.done ? `Won ${p.done}` : "", p.count - p.done ? `${p.done ? "leading" : "Leading"} in ${p.count - p.done}` : ""].filter(Boolean).join(" · ")} electorate${p.count === 1 ? "" : "s"}</div>
        <div class="tt-row">${p.count - p.maori} general · ${p.maori} Māori</div>
        <div class="tt-row">${p.close} in close race${p.close === 1 ? "" : "s"}</div>
        <div class="tt-row" style="margin-top:4px">Click to filter the table</div>`;
      bindTooltip(row, html);
      row.addEventListener("click", () => setParty(p.name));
      row.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setParty(p.name); } });
    });
  }

  function renderPartyFilter() {
    const sel = $("party-filter");
    const names = partyStats().map((p) => p.name).sort((a, b) => a.localeCompare(b));
    if (state.party && !names.includes(state.party)) names.push(state.party);
    sel.innerHTML = `<option value="">All parties</option>` +
      names.map((n) => `<option value="${esc(n)}"${n === state.party ? " selected" : ""}>${esc(n)}</option>`).join("");
  }

  function filtered() {
    const q = state.search.trim().toLowerCase();
    return state.data.electorates.filter((e) => {
      if (state.view === "key" && !e.isKey) return false;
      if (state.view === "maori" && !e.isMaori) return false;
      if (state.view === "close" && !isClose(e)) return false;
      if (state.party && partyName(e) !== state.party) return false;
      if (q && !(`${e.name} ${e.candidate} ${partyName(e)}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function sorted(list) {
    const { key, dir } = state.sort;
    const val = (e) => key === "party" ? partyName(e).toLowerCase()
      : key === "name" ? e.name.toLowerCase()
      : (e[key] ?? Infinity);
    return list.slice().sort((a, b) => {
      const va = val(a), vb = val(b);
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return c * dir || a.name.localeCompare(b.name);
    });
  }

  function renderTable() {
    const list = sorted(filtered());
    const total = state.data.electorates.length;
    $("result-count").textContent = list.length === total ? `${total} electorates` : `Showing ${list.length} of ${total} electorates`;

    document.querySelectorAll(".sort").forEach((b) => {
      if (b.dataset.sort === state.sort.key) b.setAttribute("aria-sort", state.sort.dir > 0 ? "ascending" : "descending");
      else b.removeAttribute("aria-sort");
    });
    document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.view === state.view)));

    if (!list.length) {
      $("rows").innerHTML = `<tr><td colspan="4" class="empty">No electorates match these filters.</td></tr>`;
      return;
    }
    const rowsEl = $("rows");
    withMotion(rowsEl, () => { rowsEl.innerHTML = list.map((e) => {
      const pct = Math.max(0, Math.min(100, e.percentCounted));
      const close = isClose(e);
      const tags = [
        e.isKey ? `<span class="tag">Key</span>` : "",
        e.isMaori ? `<span class="tag">Māori</span>` : "",
        state.flipped.has(e.slug) ? `<span class="tag flip${state.changedSlugs.has(e.slug) ? " pop" : ""}" title="Leading party changed since you opened this page">Lead changed</span>` : "",
      ].join("");
      return `<tr class="${state.changedSlugs.has(e.slug) ? "flash" : ""}">
        <td class="e-name"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>${tags ? `<span class="tags">${tags}</span>` : ""}
          <span class="mobile-pct">${pct.toFixed(1)}% counted</span></td>
        <td class="col-counted"><div class="counted" aria-label="${pct.toFixed(1)}% counted">
          <div class="counted-track"><div class="counted-fill" data-k="cf:${esc(e.slug)}" data-w="${pct}" style="width:${pct}%"></div></div>
          <span class="counted-pct" data-k="cp:${esc(e.slug)}" data-n="${pct}" data-fmt="pct1">${pct.toFixed(1)}%</span></div></td>
        <td><div class="lead"><span class="swatch" style="background:${esc(e.colour)}"></span>
          <div><div class="lead-cand">${esc(e.candidate || "—")}</div><div class="lead-party">${esc(partyName(e))}</div></div></div></td>
        <td class="num"><span class="margin${close ? " close" : ""}">${close ? `<span class="close-mark" title="Close: lead under ${fmt.format(closeThreshold(e))} votes at ${pct.toFixed(1)}% counted">CLOSE</span>` : ""}${e.margin != null ? `<span data-k="m:${esc(e.slug)}" data-n="${e.margin}" data-fmt="int">${fmt.format(e.margin)}</span>` : "—"}</span></td>
      </tr>`;
    }).join(""); });
  }

  // ---- tooltip ----
  const tip = $("tooltip");
  function bindTooltip(el, html) {
    const show = (x, y) => {
      tip.innerHTML = html;
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      const left = Math.min(window.innerWidth - r.width - 8, x + 14);
      const top = y + r.height + 20 > window.innerHeight ? y - r.height - 12 : y + 14;
      tip.style.left = `${Math.max(8, left)}px`;
      tip.style.top = `${Math.max(8, top)}px`;
    };
    el.addEventListener("mousemove", (ev) => show(ev.clientX, ev.clientY));
    el.addEventListener("mouseleave", () => { tip.hidden = true; });
    el.addEventListener("focus", () => { const r = el.getBoundingClientRect(); show(r.left + r.width / 2, r.bottom - 10); });
    el.addEventListener("blur", () => { tip.hidden = true; });
  }

  // ---- controls ----
  function setParty(name) {
    state.party = state.party === name ? "" : name;
    renderPartyFilter();
    renderTable();
    document.getElementById("table-h").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("search").addEventListener("input", (ev) => { state.search = ev.target.value; if (state.data) renderTable(); });
  $("party-filter").addEventListener("change", (ev) => { state.party = ev.target.value; if (state.data) renderTable(); });
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    state.view = b.dataset.view; savePrefs(); if (state.data) renderTable();
  }));
  document.querySelectorAll(".sort").forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.sort;
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: key === "percentCounted" ? -1 : 1 };
    savePrefs();
    if (state.data) renderTable();
  }));
  $("refresh-btn").addEventListener("click", () => load({ manual: true }));

  // ---- timers ----
  setInterval(() => {
    if (Date.now() >= state.nextRefreshAt) load();
    renderStatus();
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.lastFetchOk && Date.now() - state.lastFetchOk > REFRESH_MS) load();
  });

  load();
})();
