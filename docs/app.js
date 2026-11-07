(() => {
  "use strict";

  const DATA_URL = "data/electorates.json";
  const REFRESH_MS = 2 * 60 * 1000;
  const CLOSE_MARGIN = 1000;
  const STALE_MS = 10 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat("en-NZ");
  const timeFmt = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland", hour: "numeric", minute: "2-digit", day: "numeric", month: "short",
  });

  const state = {
    data: null,
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
    state.prevLeaders = leaders;
    state.prevSigs = sigs;
    state.data = data;
    renderAll();
  }

  // ---- rendering ----
  function renderAll() {
    renderMeta();
    renderTiles();
    renderBars();
    renderPartyFilter();
    renderTable();
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
    const close = withMargin.filter((e) => e.margin < CLOSE_MARGIN);
    const closest = withMargin.slice().sort((a, b) => a.margin - b.margin)[0];

    $("t-count").textContent = n;
    $("t-count-sub").textContent = `${done} fully counted`;
    $("t-avg").textContent = `${avg.toFixed(1)}%`;
    $("t-avg-sub").textContent = "simple average across electorates";
    $("t-close").textContent = close.length;
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
      if (!map.has(name)) map.set(name, { name, colour: e.colour, count: 0, maori: 0, close: 0 });
      const p = map.get(name);
      p.count++;
      if (e.isMaori) p.maori++;
      if (e.margin != null && e.margin < CLOSE_MARGIN) p.close++;
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function renderBars() {
    const stats = partyStats();
    const max = Math.max(1, ...stats.map((p) => p.count));
    const el = $("party-bars");
    el.innerHTML = stats.map((p) => `
      <div class="bar-row" role="listitem" tabindex="0" data-party="${esc(p.name)}"
           aria-label="${esc(p.name)}: leading in ${p.count} electorates">
        <span class="bar-label"><span class="swatch" style="background:${esc(p.colour)}"></span>${esc(p.name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(p.count / max) * 100}%;background:${esc(p.colour)}"></span></span>
        <span class="bar-value">${p.count}</span>
      </div>`).join("");
    el.querySelectorAll(".bar-row").forEach((row) => {
      const p = stats.find((s) => s.name === row.dataset.party);
      const html = `<strong>${esc(p.name)}</strong>
        <div class="tt-row">Leading in ${p.count} electorate${p.count === 1 ? "" : "s"}</div>
        <div class="tt-row">${p.count - p.maori} general · ${p.maori} Māori</div>
        <div class="tt-row">${p.close} with margin under ${fmt.format(CLOSE_MARGIN)}</div>
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
      if (state.view === "close" && !(e.margin != null && e.margin < CLOSE_MARGIN)) return false;
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
    $("rows").innerHTML = list.map((e) => {
      const pct = Math.max(0, Math.min(100, e.percentCounted));
      const close = e.margin != null && e.margin < CLOSE_MARGIN;
      const tags = [
        e.isKey ? `<span class="tag">Key</span>` : "",
        e.isMaori ? `<span class="tag">Māori</span>` : "",
        state.flipped.has(e.slug) ? `<span class="tag flip" title="Leading party changed since you opened this page">Lead changed</span>` : "",
      ].join("");
      return `<tr class="${state.changedSlugs.has(e.slug) ? "flash" : ""}">
        <td class="e-name"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>${tags ? `<span class="tags">${tags}</span>` : ""}
          <span class="mobile-pct">${pct.toFixed(1)}% counted</span></td>
        <td class="col-counted"><div class="counted" aria-label="${pct.toFixed(1)}% counted">
          <div class="counted-track"><div class="counted-fill" style="width:${pct}%"></div></div>
          <span class="counted-pct">${pct.toFixed(1)}%</span></div></td>
        <td><div class="lead"><span class="swatch" style="background:${esc(e.colour)}"></span>
          <div><div class="lead-cand">${esc(e.candidate || "—")}</div><div class="lead-party">${esc(partyName(e))}</div></div></div></td>
        <td class="num"><span class="margin${close ? " close" : ""}">${close ? `<span class="close-mark">CLOSE</span>` : ""}${e.margin != null ? fmt.format(e.margin) : "—"}</span></td>
      </tr>`;
    }).join("");
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
