const REFRESH_INTERVAL_MS = 60000;

const CATEGORY_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];
const categoryColorCache = new Map();

function colorForCategory(name) {
  if (!categoryColorCache.has(name)) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    categoryColorCache.set(name, CATEGORY_COLORS[hash % CATEGORY_COLORS.length]);
  }
  return categoryColorCache.get(name);
}

// ---------- Elements ----------

const refreshBtn = document.getElementById('refreshBtn');
const refreshIcon = document.getElementById('refreshIcon');
const errorBanner = document.getElementById('errorBanner');
const errorText = document.getElementById('errorText');

const casesHead = document.getElementById('casesHead');
const casesBody = document.getElementById('casesBody');
const casesCount = document.getElementById('casesCount');
const casesEmpty = document.getElementById('casesEmpty');
const casesTable = document.getElementById('casesTable');

const SERVICES = ['aa', 'ae', 'gstore'];
const SERVICE_LABEL = { aa: 'AA', ae: 'AE', gstore: 'gStore' };
const SERVICE_COLOR = { aa: '#3B82F6', ae: '#F97316', gstore: '#8B5CF6' };

const cardEls = {};
SERVICES.forEach((key) => {
  cardEls[key] = {
    value: document.getElementById(`card-${key}-value`),
    report: document.getElementById(`tile-${key}-report`),
    ring: document.getElementById(`ring-${key}`),
    badge: document.getElementById(`badge-${key}`),
    share: document.getElementById(`share-${key}`),
    updated: document.getElementById(`updated-${key}`),
  };
});

// ---------- Hero elements ----------

const heroRing = document.getElementById('heroRing');
const heroTotalValue = document.getElementById('heroTotalValue');
const heroHeadline = document.getElementById('heroHeadline');
const heroStatusBadge = document.getElementById('heroStatusBadge');
const heroLastUpdated = document.getElementById('heroLastUpdated');
const tzSelect = document.getElementById('tzSelect');
const tzClock = document.getElementById('tzClock');

// ---------- World clock ----------

const TIMEZONES = [
  { id: 'ist', label: 'India (IST)', tz: 'Asia/Kolkata' },
  { id: 'pt', label: 'US Pacific (PT)', tz: 'America/Los_Angeles' },
  { id: 'mt', label: 'US Mountain (MT)', tz: 'America/Denver' },
  { id: 'ct', label: 'US Central (CT)', tz: 'America/Chicago' },
  { id: 'et', label: 'US Eastern (ET)', tz: 'America/New_York' },
  { id: 'uk', label: 'UK (GMT/BST)', tz: 'Europe/London' },
  { id: 'sgt', label: 'Singapore (SGT)', tz: 'Asia/Singapore' },
  { id: 'utc', label: 'UTC', tz: 'UTC' },
];

const TZ_STORAGE_KEY = 'critsit-selected-timezone';

function initTimezoneSelect() {
  if (!tzSelect) return;

  TIMEZONES.forEach(({ id, label }) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    tzSelect.appendChild(opt);
  });

  const saved = localStorage.getItem(TZ_STORAGE_KEY);
  tzSelect.value = TIMEZONES.some((t) => t.id === saved) ? saved : 'ist';

  tzSelect.addEventListener('change', () => {
    localStorage.setItem(TZ_STORAGE_KEY, tzSelect.value);
    updateTzClock();
    if (typeof refreshCheckedAtDisplay === 'function') refreshCheckedAtDisplay();
    if (typeof refreshCasesDisplay === 'function') refreshCasesDisplay();
    // Trend day-buckets are computed server-side in the selected timezone,
    // so switching zones needs a re-fetch, not just a re-format.
    if (typeof loadTrend === 'function' && typeof currentTrendRange !== 'undefined') loadTrend(currentTrendRange);
    if (typeof refreshOpenTrendModal === 'function') refreshOpenTrendModal();
    // History day-buckets are computed server-side in the selected timezone too.
    if (typeof loadHistory === 'function') loadHistory();
  });

  updateTzClock();
  setInterval(updateTzClock, 1000);
}

function updateTzClock() {
  if (!tzSelect || !tzClock) return;
  const zone = TIMEZONES.find((t) => t.id === tzSelect.value) || TIMEZONES[0];
  const now = new Date();
  const datePart = now.toLocaleDateString('en-US', {
    timeZone: zone.tz,
    day: '2-digit',
    month: 'short',
  });
  const timePart = now.toLocaleTimeString('en-US', {
    timeZone: zone.tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  tzClock.textContent = `${datePart}, ${timePart}`;
}

function getSelectedTimezone() {
  const id = (tzSelect && tzSelect.value) || localStorage.getItem(TZ_STORAGE_KEY);
  const zone = TIMEZONES.find((t) => t.id === id);
  return zone ? zone.tz : 'Asia/Kolkata';
}

initTimezoneSelect();

const RING_GAUGE_MAX = 20;
const WARNING_THRESHOLD = 1;
const CRITICAL_THRESHOLD = 4;

let previousCounts = null;
let previousTotal = null;
let lastCheckedAt = null;

function ringPct(count) {
  return Math.max(0, 1 - Math.min(count, RING_GAUGE_MAX) / RING_GAUGE_MAX);
}

function classifyQueue(count) {
  if (count >= CRITICAL_THRESHOLD) return 'critical';
  if (count >= WARNING_THRESHOLD) return 'warning';
  return 'healthy';
}

function trendLabel(current, previous) {
  if (previous === null || current === previous) return 'No change';
  return current > previous ? `Up from ${previous}` : `Down from ${previous}`;
}

function formatTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('day')} ${get('month')}, ${get('hour')}:${get('minute')} ${get('timeZoneName')}`.trim();
}

function refreshCheckedAtDisplay() {
  if (!lastCheckedAt) return;
  const checkedAt = formatTime(lastCheckedAt, getSelectedTimezone());
  if (heroLastUpdated) heroLastUpdated.textContent = checkedAt;
  SERVICES.forEach((key) => {
    cardEls[key].updated.textContent = `Updated ${checkedAt}`;
  });
}

// ---------- Ticket cards ----------

function updateCard(key, count) {
  const el = cardEls[key];
  el.value.textContent = count;
  el.value.classList.remove('is-loading');
}

function updateCardExtras(key, count, total, checkedAt) {
  const el = cardEls[key];
  const status = classifyQueue(count);

  el.ring.style.setProperty('--pct', ringPct(count));
  el.badge.textContent = status === 'healthy' ? 'All clear' : status === 'warning' ? 'Attention' : 'Critical';
  el.badge.className = `tcard-status-badge is-${status === 'healthy' ? 'good' : status}`;

  el.share.textContent = total > 0 ? `${Math.round((count / total) * 100)}%` : '—';
  el.updated.textContent = `Updated ${checkedAt}`;
}

function updateHero(counts, checkedAt) {
  const total = SERVICES.reduce((sum, key) => sum + counts[key], 0);
  const status = SERVICES.reduce((worst, key) => {
    const s = classifyQueue(counts[key]);
    const rank = { healthy: 0, warning: 1, critical: 2 };
    return rank[s] > rank[worst] ? s : worst;
  }, 'healthy');

  // Ring color: red if any tickets open, green if all clear
  const ringColor = total > 0 ? 'var(--danger)' : 'var(--primary)';
  heroRing.style.setProperty('--pct', ringPct(total));
  heroRing.style.setProperty('--ring-color', ringColor);
  heroTotalValue.style.color = ringColor;

  heroTotalValue.textContent = total;
  heroHeadline.textContent = total === 0 ? 'All systems clear' : `${total} Ticket${total === 1 ? '' : 's'} Open`;


  const badgeClass = status === 'healthy' ? 'good' : status;
  const badgeText = status === 'healthy' ? 'All systems clear' : status === 'warning' ? 'Needs attention' : 'Critical issues';
  heroStatusBadge.className = `hero-status-badge is-${badgeClass}`;
  heroStatusBadge.innerHTML = `<span class="hero-status-dot" aria-hidden="true"></span> ${badgeText}`;

  if (heroLastUpdated) heroLastUpdated.textContent = checkedAt;

  return { total, status };
}

function countByService(rows) {
  const counts = { aa: 0, ae: 0, gstore: 0 };
  rows.forEach((row) => {
    if (row.__service in counts) counts[row.__service]++;
  });
  return counts;
}

function setReportLink(el, url) {
  if (!url) return;
  el.href = url;
  el.hidden = false;
}

// ---------- Cases table ----------

function isUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

const JOIN_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <rect x="2.5" y="6" width="13" height="12" rx="2.2" stroke="currentColor" stroke-width="1.8"/>
  <path d="M15.5 10.2 21 7v10l-5.5-3.2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
</svg>`;

// Salesforce's list view API always serializes datetime fields as a raw
// GMT string (e.g. "Wed Aug 12 11:38:15 GMT 2026"), regardless of org or
// user locale — so it has to be re-formatted client-side into whichever
// zone is selected in the dropdown. Elapsed-duration fields like
// "0d 0h 56m" also match the /time|aging|duration/i field check but
// aren't parseable dates, so they fall through unchanged.
function formatDateValueInZone(value, timeZone) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  const ampm = get('dayPeriod').toUpperCase();
  return `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')}:${get('second')} ${ampm} ${get('timeZoneName')}`;
}

function renderCell(field, value, row) {
  const td = document.createElement('td');

  if (value === null || value === undefined || value === '') {
    td.classList.add('cell-muted');
    td.textContent = '–';
    return td;
  }

  if (isUrl(value)) {
    td.innerHTML = `<a class="join-btn" href="${value}" target="_blank" rel="noopener noreferrer">${JOIN_ICON}Join</a>`;
    return td;
  }

  if (field === '__service') {
    const pill = document.createElement('span');
    pill.className = 'category-pill';
    pill.style.setProperty('--cat-color', SERVICE_COLOR[value]);
    pill.textContent = SERVICE_LABEL[value];
    td.appendChild(pill);
    return td;
  }

  if (field === 'Category__c') {
    const pill = document.createElement('span');
    pill.className = 'category-pill';
    pill.style.setProperty('--cat-color', colorForCategory(String(value)));
    pill.textContent = value;
    td.appendChild(pill);
    return td;
  }

  if (/CaseNumber$/.test(field)) {
    td.classList.add('case-number');
    if (row?.__caseUrl) {
      const link = document.createElement('a');
      link.className = 'case-number-link';
      link.href = row.__caseUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = value;
      td.appendChild(link);
    } else {
      td.textContent = value;
    }
    return td;
  }

  if (/time|aging|duration/i.test(field)) {
    td.classList.add('col-mono');
    const formatted = formatDateValueInZone(value, getSelectedTimezone());
    td.textContent = formatted !== null ? formatted : value;
    return td;
  }

  td.textContent = value;
  return td;
}

let lastCasesData = null;

function refreshCasesDisplay() {
  if (lastCasesData) renderCases(lastCasesData);
}

function renderCases(cases) {
  lastCasesData = cases;
  casesHead.innerHTML = '';
  casesBody.innerHTML = '';

  const headRow = document.createElement('tr');
  cases.columns.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col.label;
    headRow.appendChild(th);
  });
  casesHead.appendChild(headRow);

  cases.rows.forEach((row) => {
    const tr = document.createElement('tr');
    cases.columns.forEach((col) => {
      tr.appendChild(renderCell(col.field, row[col.field], row));
    });
    casesBody.appendChild(tr);
  });

  casesCount.textContent = `${cases.size} item${cases.size === 1 ? '' : 's'}`;
  const empty = cases.rows.length === 0;
  casesTable.hidden = empty;
  casesEmpty.hidden = !empty;
}

// ---------- Main load ----------

let refreshTimer = null;

async function loadDashboard() {
  refreshIcon.classList.add('spinning');
  refreshBtn.disabled = true;
  try {
    const res = await fetch('/api/dashboard', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    const counts = countByService(data.cases.rows);
    SERVICES.forEach((key) => updateCard(key, counts[key]));
    setReportLink(cardEls.aa.report, data.reportUrls?.aa);
    setReportLink(cardEls.ae.report, data.reportUrls?.ae);
    setReportLink(cardEls.gstore.report, data.reportUrls?.gstore);

    renderCases(data.cases);

    lastCheckedAt = new Date();
    const checkedAt = formatTime(lastCheckedAt, getSelectedTimezone());
    const { total } = updateHero(counts, checkedAt);
    SERVICES.forEach((key) => updateCardExtras(key, counts[key], total, checkedAt));

    previousCounts = counts;
    previousTotal = total;

    errorBanner.hidden = true;
  } catch (err) {
    errorText.textContent = `Couldn't refresh: ${err.message}`;
    errorBanner.hidden = false;
    // Only the first load leaves skeleton rows in casesBody/casesHead — once
    // renderCases has run once, a later failed refresh just keeps showing
    // the last-known cases instead of blanking the table.
    if (!lastCasesData) {
      casesHead.innerHTML = '';
      casesBody.innerHTML = `<tr><td class="cell-muted">Could not load ticket details.</td></tr>`;
      casesTable.hidden = false;
      casesEmpty.hidden = true;
    }
  } finally {
    refreshIcon.classList.remove('spinning');
    refreshBtn.disabled = false;
  }
}

function scheduleAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(loadDashboard, REFRESH_INTERVAL_MS);
}

refreshBtn.addEventListener('click', () => {
  loadDashboard();
});

loadDashboard();
scheduleAutoRefresh();

// ============================================================
// Trend Chart — Sev 1+2, Impact >= 50%, Incidents only
// ============================================================

const TREND_SVCS = [
  { key: "aa",     color: "#3b82f6", label: "AA" },
  { key: "ae",     color: "#f97316", label: "AE" },
  { key: "gstore", color: "#8b5cf6", label: "gStore" },
];
const SVG_NS = "http://www.w3.org/2000/svg";
let currentTrendRange = "7d";

function mkSvg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
  return el;
}

function smoothLinePath(pts) {
  if (!pts.length) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const dx = (x1 - x0) * 0.4;
    d += ` C${x0 + dx},${y0} ${x1 - dx},${y1} ${x1},${y1}`;
  }
  return d;
}

function niceYMax(v) {
  if (v <= 0) return 5;
  const raw = v * 1.3;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  return Math.ceil(raw / exp) * exp;
}

function trendDateLabel(dateStr, range) {
  const d = new Date(dateStr + "T00:00:00Z");
  if (range === "6m") return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
  return d.toLocaleDateString("en-GB", { month: "short", day: "numeric", timeZone: "UTC" });
}

function renderTrendChart(data) {
  const svg = document.getElementById("trendChart");
  const wrap = document.getElementById("trendWrap");
  const trendEmpty = document.getElementById("trendEmpty");
  const tooltip = document.getElementById("trendTooltip");

  svg.innerHTML = "";
  tooltip.hidden = true;

  if (!data || !data.length) {
    trendEmpty.hidden = false;
    return;
  }
  trendEmpty.hidden = true;

  const W = Math.max(svg.getBoundingClientRect().width || 800, 200);
  const H = 264;
  const PAD = { top: 18, right: 16, bottom: 46, left: 40 };
  const CW = W - PAD.left - PAD.right;
  const CH = H - PAD.top - PAD.bottom;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const allVals = data.flatMap(d => TREND_SVCS.map(s => d[s.key]));
  const yMax = niceYMax(Math.max(...allVals, 0));

  const xOf = i => data.length <= 1 ? PAD.left + CW / 2 : PAD.left + (i / (data.length - 1)) * CW;
  const yOf = v => PAD.top + CH * (1 - v / yMax);

  // Y grid + labels
  for (let s = 0; s <= 4; s++) {
    const fy = s / 4;
    const y = PAD.top + fy * CH;
    svg.appendChild(mkSvg("line", { x1: PAD.left, y1: y, x2: W - PAD.right, y2: y, stroke: "rgba(255,255,255,0.07)", "stroke-width": 1 }));
    const lbl = mkSvg("text", { x: PAD.left - 7, y: y + 4, "text-anchor": "end", "font-size": 10, fill: "#6b7280", "font-family": "inherit" });
    lbl.textContent = Math.round(yMax * (1 - fy));
    svg.appendChild(lbl);
  }

  // X axis labels (up to 8)
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));
  data.forEach((d, i) => {
    if (i % labelEvery !== 0 && i !== data.length - 1) return;
    const lbl = mkSvg("text", { x: xOf(i), y: H - PAD.bottom + 18, "text-anchor": "middle", "font-size": 10, fill: "#6b7280", "font-family": "inherit" });
    lbl.textContent = trendDateLabel(d.date, currentTrendRange);
    svg.appendChild(lbl);
  });

  // Axis borders
  svg.appendChild(mkSvg("line", { x1: PAD.left, y1: PAD.top, x2: PAD.left, y2: PAD.top + CH, stroke: "rgba(255,255,255,0.1)", "stroke-width": 1 }));
  svg.appendChild(mkSvg("line", { x1: PAD.left, y1: PAD.top + CH, x2: W - PAD.right, y2: PAD.top + CH, stroke: "rgba(255,255,255,0.1)", "stroke-width": 1 }));

  // Area fills + lines
  const bottom = PAD.top + CH;
  TREND_SVCS.forEach(({ key, color }) => {
    const pts = data.map((d, i) => [xOf(i), yOf(d[key])]);
    if (pts.length < 2) return;
    const lp = smoothLinePath(pts);

    svg.appendChild(mkSvg("path", {
      d: `${lp} L${pts[pts.length - 1][0]},${bottom} L${pts[0][0]},${bottom} Z`,
      fill: color, opacity: 0.08, "pointer-events": "none"
    }));
    svg.appendChild(mkSvg("path", {
      d: lp, fill: "none", stroke: color, "stroke-width": 2,
      "stroke-linecap": "round", "stroke-linejoin": "round", "pointer-events": "none"
    }));

    if (data.length <= 31) {
      pts.forEach(([cx, cy]) => {
        svg.appendChild(mkSvg("circle", { cx, cy, r: 3, fill: color, "pointer-events": "none" }));
      });
    }
  });

  // Crosshair
  const crosshair = mkSvg("line", {
    x1: 0, y1: PAD.top, x2: 0, y2: PAD.top + CH,
    stroke: "rgba(255,255,255,0.2)", "stroke-width": 1, "stroke-dasharray": "4 3",
    visibility: "hidden", "pointer-events": "none"
  });
  svg.appendChild(crosshair);

  // Hover dots
  const hDots = {};
  TREND_SVCS.forEach(({ key, color }) => {
    const dot = mkSvg("circle", { cx: 0, cy: 0, r: 5, fill: color, stroke: "#111827", "stroke-width": 1.5, visibility: "hidden", "pointer-events": "none" });
    svg.appendChild(dot);
    hDots[key] = dot;
  });

  // Hover overlay
  const overlay = mkSvg("rect", { x: PAD.left, y: PAD.top, width: CW, height: CH, fill: "transparent", cursor: "crosshair" });

  overlay.addEventListener("mousemove", e => {
    const svgRect = svg.getBoundingClientRect();
    const svgX = (e.clientX - svgRect.left) * (W / svgRect.width);
    const i = Math.max(0, Math.min(data.length - 1, Math.round((svgX - PAD.left) / CW * (data.length - 1))));
    const d = data[i];
    const x = xOf(i);

    crosshair.setAttribute("x1", x);
    crosshair.setAttribute("x2", x);
    crosshair.setAttribute("visibility", "visible");

    TREND_SVCS.forEach(({ key }) => {
      hDots[key].setAttribute("cx", x);
      hDots[key].setAttribute("cy", yOf(d[key]));
      hDots[key].setAttribute("visibility", "visible");
    });

    const dateLabel = new Date(d.date + "T00:00:00Z").toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
    });
    tooltip.innerHTML =
      `<div class="tt-date">${dateLabel}</div>` +
      TREND_SVCS.map(({ key, color, label }) =>
        `<div class="tt-row"><span class="tt-dot" style="background:${color}"></span><span class="tt-svc">${label}</span><strong>${d[key]}</strong></div>`
      ).join("") +
      `<div class="tt-hint">Click a line to view tickets</div>`;

    const wrapRect = wrap.getBoundingClientRect();
    const px = e.clientX - wrapRect.left;
    const py = e.clientY - wrapRect.top;
    const TTW = 152;
    tooltip.style.left = (px + 14 + TTW > wrapRect.width ? px - TTW - 14 : px + 14) + "px";
    tooltip.style.top = Math.max(4, py - 52) + "px";
    tooltip.hidden = false;
  });

  overlay.addEventListener("mouseleave", () => {
    crosshair.setAttribute("visibility", "hidden");
    TREND_SVCS.forEach(({ key }) => hDots[key].setAttribute("visibility", "hidden"));
    tooltip.hidden = true;
  });

  overlay.addEventListener("click", e => {
    const svgRect = svg.getBoundingClientRect();
    const svgX = (e.clientX - svgRect.left) * (W / svgRect.width);
    const svgY = (e.clientY - svgRect.top) * (H / svgRect.height);
    const i = Math.max(0, Math.min(data.length - 1, Math.round((svgX - PAD.left) / CW * (data.length - 1))));
    const d = data[i];

    // Pick whichever series' point sits closest to the click, so clicking
    // the AA dot/line shows AA tickets, not every service for that date.
    let closestSvc = TREND_SVCS[0].key;
    let closestDist = Infinity;
    TREND_SVCS.forEach(({ key }) => {
      const dist = Math.abs(yOf(d[key]) - svgY);
      if (dist < closestDist) { closestDist = dist; closestSvc = key; }
    });

    openTrendDetailModal(d, closestSvc);
  });

  svg.appendChild(overlay);
}

async function loadTrend(range) {
  currentTrendRange = range;
  const loading = document.getElementById("trendLoading");
  const trendEmpty = document.getElementById("trendEmpty");
  loading.hidden = false;
  trendEmpty.hidden = true;
  document.getElementById("trendChart").innerHTML = "";
  document.getElementById("trendTooltip").hidden = true;

  try {
    const res = await fetch(`/api/trend?range=${range}&tz=${encodeURIComponent(getSelectedTimezone())}`, { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    renderTrendChart(json.trend || []);
  } catch (err) {
    const trendEmpty = document.getElementById("trendEmpty");
    trendEmpty.textContent = `Could not load trend: ${err.message}`;
    trendEmpty.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

document.querySelectorAll(".trange-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".trange-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    loadTrend(btn.dataset.range);
  });
});

window.addEventListener("resize", () => {
  if (document.getElementById("trendChart").innerHTML) loadTrend(currentTrendRange);
});

loadTrend(currentTrendRange);

// ============================================================
// Trend drill-down modal — lists the Salesforce cases behind a
// clicked point on the trend chart.
// ============================================================

const trendModal = document.getElementById("trendDetailModal");
const trendModalTitle = document.getElementById("trendModalTitle");
const trendModalBody = document.getElementById("trendModalBody");
let lastTrendModalArgs = null;

function refreshOpenTrendModal() {
  if (!trendModal.hidden && lastTrendModalArgs) {
    openTrendDetailModal(lastTrendModalArgs.dayEntry, lastTrendModalArgs.service);
  }
}

function closeTrendModal() {
  trendModal.hidden = true;
}

document.getElementById("trendModalClose").addEventListener("click", closeTrendModal);
document.getElementById("trendModalBackdrop").addEventListener("click", closeTrendModal);
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !trendModal.hidden) closeTrendModal();
});

function trendCaseRow(c) {
  const row = document.createElement("div");
  row.className = "trend-case-row";

  const pill = document.createElement("span");
  pill.className = "category-pill";
  pill.style.setProperty("--cat-color", SERVICE_COLOR[c.service]);
  pill.textContent = SERVICE_LABEL[c.service];

  const main = document.createElement("div");
  main.className = "trend-case-main";

  const top = document.createElement("div");
  const link = document.createElement("a");
  link.className = "case-number-link";
  link.href = c.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = c.caseNumber;
  top.appendChild(link);

  const subject = document.createElement("p");
  subject.className = "trend-case-subject";
  subject.textContent = c.subject || "(no subject)";

  const meta = document.createElement("div");
  meta.className = "trend-case-meta";
  const impact = c.impact != null ? `${c.impact}%` : "–";
  const created = c.createdDate
    ? new Date(c.createdDate).toLocaleString("en-GB", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
        timeZone: getSelectedTimezone(),
      })
    : "–";
  meta.textContent = `${c.severity || "–"} · Impact ${impact} · ${created}`;

  main.appendChild(top);
  main.appendChild(subject);
  main.appendChild(meta);

  row.appendChild(pill);
  row.appendChild(main);
  return row;
}

async function openTrendDetailModal(dayEntry, service) {
  if (!dayEntry) return;
  lastTrendModalArgs = { dayEntry, service };
  const dateLabel = new Date(dayEntry.date + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
  });
  const svcLabel = service ? SERVICE_LABEL[service] : null;
  trendModalTitle.textContent = svcLabel
    ? `${svcLabel} Critical Cases — ${dateLabel}`
    : `Critical Cases — ${dateLabel}`;
  trendModalBody.innerHTML = `<div class="trend-modal-empty">Loading&hellip;</div>`;
  trendModal.hidden = false;

  try {
    const res = await fetch(`/api/trend/detail?date=${dayEntry.date}&tz=${encodeURIComponent(getSelectedTimezone())}`, { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);

    const cases = service ? (json.cases || []).filter(c => c.service === service) : (json.cases || []);

    trendModalBody.innerHTML = "";
    if (!cases.length) {
      trendModalBody.innerHTML = `<div class="trend-modal-empty">No matching cases on this date.</div>`;
      return;
    }
    cases.forEach(c => trendModalBody.appendChild(trendCaseRow(c)));
  } catch (err) {
    trendModalBody.innerHTML = `<div class="trend-modal-empty">Could not load cases: ${err.message}</div>`;
  }
}

// ============================================================
// 7 Day History of Tickets — same filter as the trend chart
// (Sev 1+2, Impact >= 50%, Incidents only), grouped by calendar
// day in the selected timezone.
// ============================================================

const HISTORY_DAYS = 3;

function dayKeyInZoneClient(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(date).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function historyDayLabel(dayKey) {
  const tz = getSelectedTimezone();
  const today = dayKeyInZoneClient(new Date(), tz);
  const yesterday = dayKeyInZoneClient(new Date(Date.now() - 86400000), tz);
  if (dayKey === today) return "Today";
  if (dayKey === yesterday) return "Yesterday";
  return new Date(dayKey + "T00:00:00Z").toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });
}

function formatResolutionDuration(ms) {
  if (ms == null || ms < 0) return null;
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function historyRow(c) {
  const tr = document.createElement("tr");

  const dateTd = document.createElement("td");
  dateTd.classList.add("col-mono");
  const time = c.createdDate
    ? new Date(c.createdDate).toLocaleTimeString("en-GB", {
        hour: "2-digit", minute: "2-digit", timeZone: getSelectedTimezone(),
      })
    : "–";
  dateTd.textContent = c.day ? `${historyDayLabel(c.day)}, ${time}` : "–";
  tr.appendChild(dateTd);

  const caseTd = document.createElement("td");
  caseTd.classList.add("case-number");
  const link = document.createElement("a");
  link.className = "case-number-link";
  link.href = c.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = c.caseNumber;
  caseTd.appendChild(link);
  tr.appendChild(caseTd);

  const accountTd = document.createElement("td");
  if (!c.accountName) accountTd.classList.add("cell-muted");
  accountTd.textContent = c.accountName || "–";
  tr.appendChild(accountTd);

  const subjectTd = document.createElement("td");
  subjectTd.textContent = c.subject || "(no subject)";
  tr.appendChild(subjectTd);

  const serviceTd = document.createElement("td");
  const pill = document.createElement("span");
  pill.className = "category-pill";
  pill.style.setProperty("--cat-color", SERVICE_COLOR[c.service]);
  pill.textContent = SERVICE_LABEL[c.service];
  serviceTd.appendChild(pill);
  tr.appendChild(serviceTd);

  const sevTd = document.createElement("td");
  sevTd.textContent = c.severity || "–";
  tr.appendChild(sevTd);

  const impactTd = document.createElement("td");
  impactTd.classList.add("col-mono");
  impactTd.textContent = c.impact != null ? `${c.impact}%` : "–";
  tr.appendChild(impactTd);

  const resolutionTd = document.createElement("td");
  resolutionTd.classList.add("col-mono");
  const resolution = formatResolutionDuration(c.resolutionMs);
  if (resolution) {
    resolutionTd.textContent = resolution;
  } else {
    resolutionTd.classList.add("cell-muted");
    resolutionTd.textContent = "Open";
  }
  tr.appendChild(resolutionTd);

  return tr;
}

function renderHistoryTable(cases) {
  const body = document.getElementById("historyBody");
  const empty = document.getElementById("historyEmpty");
  const table = document.getElementById("historyTable");
  const count = document.getElementById("historyCount");

  body.innerHTML = "";
  cases.forEach((c) => body.appendChild(historyRow(c)));

  count.textContent = `${cases.length} ticket${cases.length === 1 ? "" : "s"}`;
  const isEmpty = cases.length === 0;
  table.hidden = isEmpty;
  empty.hidden = !isEmpty;
}

async function loadHistory() {
  const body = document.getElementById("historyBody");
  const empty = document.getElementById("historyEmpty");
  const table = document.getElementById("historyTable");

  try {
    const res = await fetch(
      `/api/trend/history?days=${HISTORY_DAYS}&tz=${encodeURIComponent(getSelectedTimezone())}`,
      { cache: "no-store" }
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    renderHistoryTable(json.cases || []);
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" class="cell-muted">Could not load history: ${err.message}</td></tr>`;
    table.hidden = false;
    empty.hidden = true;
  }
}

loadHistory();
