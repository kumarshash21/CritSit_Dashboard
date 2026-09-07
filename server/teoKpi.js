// TEO KPI computation, ported from app_v2.py's render_dashboard() pipeline
// (L1330-1891) for the Software Stability page. Split in two layers:
//   fetchRawTeoData  — expensive Jira/SF fetch + EA-only computation
//                      (cached 5 min; independent of severity/pod filters)
//   deriveFiltered   — cheap, synchronous SF-cascaded recomputation that
//                      re-runs whenever the Severity/POD filters change
import {
  EA_ISSUE_TYPE,
  BUG_ISSUE_TYPE,
  discoverStageAri,
  fetchEaTicketsByStage,
  fetchEaTicketsByDate,
  fetchTeoFilterKeys,
  fetchGmTicketsByKeys,
} from './jira.js';
import { getTeoCases } from './salesforce.js';
import { getPodMap, buildPodLookup, accountPod } from './podMap.js';

// ── Ticket-status constants, ported verbatim from app_v2.py (L179-269) ────
const QA_STATUSES = new Set(['Queued for QA analysis', 'QA analysis in progress']);
const BUG_RESOLUTIONS = new Set([
  'New Bug', 'Known Bug', 'Wrong Technical Configuration',
  'Wrong Feature Configuration', 'Feature Gap',
]);
const IN_PROGRESS_STATUSES = new Set([
  'TAC Analysis', 'Reopened', 'Need More Info', 'Queued for QA analysis',
  'QA analysis in progress', 'Queued for Dev Analysis', 'Dev Analysis in progress',
]);
const STRICT_BUG_RESOLUTIONS = new Set(['New Bug', 'Known Bug', 'Missed Checkin']);
const EA_BUG_KPI_RESOLUTIONS = new Set(['Known Bug', 'New Bug']);
const PROCESS_GAP_RESOLUTIONS = new Set([
  'Wrong Technical Configuration', 'Wrong Feature Configuration',
  'New Requirement', 'Sysops Issue', 'Upgrade Procedure',
]);
const DUPLICATE_RESOLUTION = 'Duplicate';
const BUG_REJECTED_STATUS = 'Rejected';
const CONCLUDED_STATUSES = new Set(['Done', 'No longer an issue', 'Unable to Conclude']);
const QA_IN_PROGRESS_STATUS = 'QA analysis in progress';

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const RAW_CACHE_TTL_MS = 5 * 60 * 1000; // matches app_v2.py's st.cache_data(ttl=300)
const DRILLDOWN_ROW_CAP = 50;

// ── Small helpers ───────────────────────────────────────────────────────────
function pad(n) {
  return String(n).padStart(2, '0');
}

function istPeriodBounds(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  const periodStartUtcMs = Date.UTC(year, month - 1, 1, 0, 0, 0) - IST_OFFSET_MS;
  const periodEndUtcMs = Date.UTC(year, month - 1, lastDay + 1, 0, 0, 0) - IST_OFFSET_MS;
  return { lastDay, periodStartUtcMs, periodEndUtcMs };
}

/** Current year/month (1-indexed) as seen in IST — used as the request default. */
export function currentIstYearMonth() {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1 };
}

function normalizeOffset(s) {
  // Jira sends "+0530" (no colon); JS Date parses "+05:30" reliably.
  return /[+-]\d{4}$/.test(s) ? `${s.slice(0, -2)}:${s.slice(-2)}` : s;
}

function parseJiraDate(s) {
  if (!s) return null;
  const d = new Date(normalizeOffset(s));
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(d) {
  const dt = d instanceof Date ? d : parseJiraDate(d);
  return dt ? dt.toISOString().slice(0, 10) : '';
}

// ── Ticket field readers (operate on raw Jira issue JSON) ──────────────────
function getResolution(ticket) {
  const r = ticket.fields?.resolution;
  return r ? r.name || '' : '';
}
function getStatus(ticket) {
  return ticket.fields?.status?.name || '';
}
function getLabels(ticket) {
  return ticket.fields?.labels || [];
}
function getLinkedByType(ticket, issueType) {
  const keys = [];
  for (const link of ticket.fields?.issuelinks || []) {
    for (const side of ['outwardIssue', 'inwardIssue']) {
      const linked = link[side];
      if (linked?.fields?.issuetype?.name === issueType && linked.key) keys.push(linked.key);
    }
  }
  return keys;
}
function getLinkedBugs(ticket) {
  return getLinkedByType(ticket, BUG_ISSUE_TYPE);
}
function getLinkedEaKeys(ticket) {
  return getLinkedByType(ticket, EA_ISSUE_TYPE);
}
function ticketReachedQa(ticket) {
  for (const h of ticket.changelog?.histories || []) {
    for (const item of h.items || []) {
      if (item.field === 'status' && QA_STATUSES.has(item.toString)) return true;
    }
  }
  return false;
}
function ticketReachedQaInProgress(ticket) {
  for (const h of ticket.changelog?.histories || []) {
    for (const item of h.items || []) {
      if (item.field === 'status' && item.toString === QA_IN_PROGRESS_STATUS) return true;
    }
  }
  return false;
}
function findStatusTransitionDate(ticket, statusName) {
  if (!ticket) return null;
  let found = null;
  for (const h of ticket.changelog?.histories || []) {
    for (const item of h.items || []) {
      if (item.field === 'status' && item.toString === statusName) found = h.created;
    }
  }
  return found;
}
function ticketIsInProgress(ticket) {
  return IN_PROGRESS_STATUSES.has(getStatus(ticket));
}
function ticketIsConcludedV2(ticket) {
  return CONCLUDED_STATUSES.has(getStatus(ticket));
}
function ticketHasPgResolution(ticket) {
  return PROCESS_GAP_RESOLUTIONS.has(getResolution(ticket));
}

function ticketInPeriodIst(ticket, bounds) {
  const d = parseJiraDate(ticket.fields?.created);
  if (!d) return false;
  const t = d.getTime();
  return t >= bounds.periodStartUtcMs && t < bounds.periodEndUtcMs;
}

const GM_KEY_RE = /\b(GM-\d+)\b/i;
function caseLinkedGmKey(caseObj) {
  for (const field of ['Jira_Ticket_Id__c', 'Jira_Ticket_URL__c']) {
    const val = caseObj[field];
    if (val) {
      const m = String(val).match(GM_KEY_RE);
      if (m) return m[1].toUpperCase();
    }
  }
  return null;
}

function buildGmStatusEntry(t) {
  return {
    key: t.key,
    reachedQa: ticketReachedQa(t),
    reachedQaIp: ticketReachedQaInProgress(t),
    hasBug: BUG_RESOLUTIONS.has(getResolution(t)),
    hasStrictBug: STRICT_BUG_RESOLUTIONS.has(getResolution(t)),
    hasKpiBug: EA_BUG_KPI_RESOLUTIONS.has(getResolution(t)), // patched by resolvesToKpiBug below
    hasPg: ticketHasPgResolution(t),
    status: getStatus(t),
    resolution: getResolution(t),
    isConcludedV2: ticketIsConcludedV2(t),
    isInProgress: ticketIsInProgress(t),
    teoReviewed: getLabels(t).some((l) => ['pdu_reviewed', 'teo_reviewed'].includes(l)),
    resolutionDate: t.fields?.resolutiondate || null,
    summary: t.fields?.summary || '',
  };
}

function buildSfRow(c, gmStatus, inPeriodEaKeys) {
  const gmKeyRaw = caseLinkedGmKey(c);
  const gmInPeriod = Boolean(gmKeyRaw && inPeriodEaKeys.has(gmKeyRaw));
  const gmInfo = gmInPeriod ? gmStatus.get(gmKeyRaw) : null;
  const created = c.CreatedDate;
  const closed = c.ClosedDate;
  let resolveHours = null;
  if (created && closed) {
    const t0 = new Date(created).getTime();
    const t1 = new Date(closed).getTime();
    if (!Number.isNaN(t0) && !Number.isNaN(t1)) resolveHours = (t1 - t0) / 3600000;
  }
  return {
    caseNumber: c.CaseNumber || '',
    status: c.Status || '',
    isClosed: Boolean(c.IsClosed),
    isEscalated: Boolean(c.IsEscalated),
    gmKeyRaw: gmKeyRaw || '',
    gmKey: gmInPeriod ? gmKeyRaw : '',
    gmStatus: gmInfo?.status || '',
    slaCategory: c.SLA_Category__c || '',
    product: c.Product_Type__c || 'Unspecified',
    account: c.Account_Name__c || 'Unknown',
    createdDate: created,
    resolveHours,
  };
}

// ── Layer 1: expensive raw fetch (cached) ──────────────────────────────────
async function fetchRawTeoData({ month, year, types, products }) {
  const { lastDay, periodStartUtcMs, periodEndUtcMs } = istPeriodBounds(year, month);
  const startStr = `${year}-${pad(month)}-01`;
  const endStr = `${year}-${pad(month)}-${pad(lastDay)}`;
  const periodLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' })
    .format(new Date(year, month - 1, 1));
  const bounds = { periodStartUtcMs, periodEndUtcMs };

  // 1. EA tickets for the period (Stage-scoped, falling back to created-date).
  const stageAri = await discoverStageAri(startStr, endStr);
  const eaRaw = stageAri
    ? await fetchEaTicketsByStage(stageAri, startStr, endStr)
    : await fetchEaTicketsByDate(startStr, endStr);
  const eaTickets = eaRaw.filter((t) => ticketInPeriodIst(t, bounds));
  const eaByKey = new Map(eaTickets.map((t) => [t.key, t]).filter(([k]) => k));

  // 2. SF cases for the period — scoped by the Ticket Category / Product
  // Type filter chips when the caller supplied them (undefined falls back
  // to getTeoCases' documented default of Incident + RTP/TTP). Severity/pod/
  // site filtering happens per-request in deriveFiltered() below instead, so
  // toggling those never re-triggers this fetch.
  const sfCasesRaw = await getTeoCases(startStr, endStr, { types, products });

  // 3. Per-EA status map, from in-period EA tickets only.
  const gmStatus = new Map();
  for (const t of eaTickets) {
    if (t.key) gmStatus.set(t.key, buildGmStatusEntry(t));
  }
  const inPeriodEaKeys = new Set(gmStatus.keys());

  // 4. Duplicate-chase BFS: a "Duplicate"-resolved EA inherits its bug
  // outcome from whichever EA it links to (capped at 5 hops).
  const dupResLookup = new Map();
  const dupLinksLookup = new Map();
  const dupBugsLookup = new Map();
  for (const t of eaTickets) {
    const k = t.key;
    if (!k) continue;
    dupResLookup.set(k, getResolution(t));
    dupLinksLookup.set(k, getLinkedEaKeys(t));
    dupBugsLookup.set(k, getLinkedBugs(t));
  }
  let frontier = new Set();
  for (const [k, r] of dupResLookup) {
    if (r === DUPLICATE_RESOLUTION) {
      for (const lk of dupLinksLookup.get(k) || []) if (!dupResLookup.has(lk)) frontier.add(lk);
    }
  }
  let hops = 0;
  while (frontier.size && hops < 5) {
    hops += 1;
    const extra = await fetchGmTicketsByKeys([...frontier]);
    frontier = new Set();
    for (const t of extra) {
      const k = t.key;
      if (!k || dupResLookup.has(k)) continue;
      dupResLookup.set(k, getResolution(t));
      dupLinksLookup.set(k, getLinkedEaKeys(t));
      dupBugsLookup.set(k, getLinkedBugs(t));
      if (dupResLookup.get(k) === DUPLICATE_RESOLUTION) {
        for (const lk of dupLinksLookup.get(k) || []) if (!dupResLookup.has(lk)) frontier.add(lk);
      }
    }
  }
  function dupTargetIsBug(key, visited) {
    if (!key || visited.has(key)) return false;
    visited.add(key);
    const res = dupResLookup.get(key) || '';
    if (EA_BUG_KPI_RESOLUTIONS.has(res)) return true;
    if ((dupBugsLookup.get(key) || []).length) return true;
    if (res === DUPLICATE_RESOLUTION) {
      return (dupLinksLookup.get(key) || []).some((lk) => dupTargetIsBug(lk, visited));
    }
    return false;
  }
  function resolvesToKpiBug(key) {
    const res = dupResLookup.get(key) || '';
    if (EA_BUG_KPI_RESOLUTIONS.has(res)) return true;
    if (res === DUPLICATE_RESOLUTION) return dupTargetIsBug(key, new Set());
    return false;
  }
  for (const key of gmStatus.keys()) {
    gmStatus.get(key).hasKpiBug = resolvesToKpiBug(key);
  }

  // 5. SF join (unfiltered) — gm_in_period gating uses the inPeriodEaKeys
  // snapshot taken above, before any out-of-period enrichment below.
  const sfRows = sfCasesRaw.map((c) => buildSfRow(c, gmStatus, inPeriodEaKeys));
  const allLinkedKeysFromSf = new Set(sfRows.map((r) => r.gmKeyRaw).filter(Boolean));

  // 6. Enrich gm_status with linked EAs that fall OUTSIDE the period, over
  // the full (unfiltered) SF linked-key set — so later severity/pod
  // filtering never needs another Jira round-trip.
  const missingLinkedKeys = [...allLinkedKeysFromSf].filter((k) => !inPeriodEaKeys.has(k));
  if (missingLinkedKeys.length) {
    const extra = await fetchGmTicketsByKeys(missingLinkedKeys);
    for (const t of extra) {
      const k = t.key;
      if (k && !gmStatus.has(k)) gmStatus.set(k, buildGmStatusEntry(t));
    }
  }

  // 7. TEO filter + Month/Old EA status partitioning (all EA-only, so none
  // of this depends on the SF severity/pod filters).
  const teoFilterKeys = await fetchTeoFilterKeys(startStr);
  const monthEasConcludedKeys = new Set(
    [...inPeriodEaKeys].filter((k) => gmStatus.get(k)?.isConcludedV2 && !teoFilterKeys.has(k))
  );
  const monthEasInProgressKeys = new Set(
    [...inPeriodEaKeys].filter((k) => gmStatus.has(k) && !gmStatus.get(k).isConcludedV2)
  );
  const monthEasConcluded = monthEasConcludedKeys.size;
  const monthEasInProgress = monthEasInProgressKeys.size;

  // 8. EA→Bug / EA→PG / EA→Improvements — EA-quantified, filter-independent.
  const eaToBugKeys = new Set([...monthEasConcludedKeys].filter((k) => gmStatus.get(k)?.hasKpiBug));
  const eaToPgKeys = new Set([...monthEasConcludedKeys].filter((k) => gmStatus.get(k)?.hasPg));
  const eaToImprovementKeys = new Set([...eaToBugKeys, ...eaToPgKeys]);
  const eaToBugDirectCount = [...eaToBugKeys].filter((k) => EA_BUG_KPI_RESOLUTIONS.has(gmStatus.get(k)?.resolution)).length;
  const eaToBugDuplicateCount = eaToBugKeys.size - eaToBugDirectCount;

  // 9. Bug Rejection % — of the DIRECT Known/New Bug EAs, how many have a
  // linked Bug issue currently sitting in "Rejected" status.
  const directBugKeys = new Set(
    [...monthEasConcludedKeys].filter((k) => EA_BUG_KPI_RESOLUTIONS.has(gmStatus.get(k)?.resolution))
  );
  const linkedBugKeysByEa = new Map();
  for (const k of directBugKeys) {
    const t = eaByKey.get(k);
    if (t) linkedBugKeysByEa.set(k, getLinkedBugs(t));
  }
  const allLinkedBugKeys = [...new Set([...linkedBugKeysByEa.values()].flat())];
  const linkedBugTickets = allLinkedBugKeys.length ? await fetchGmTicketsByKeys(allLinkedBugKeys) : [];
  const bugTicketByKey = new Map(linkedBugTickets.map((t) => [t.key, t]));
  const bugStatusLookup = new Map(linkedBugTickets.map((t) => [t.key, getStatus(t)]));
  const bugRejectedKeys = new Set();
  const bugRejectedDateLookup = new Map();
  for (const [eaKey, bugKeys] of linkedBugKeysByEa) {
    const rejectedBug = bugKeys.find((bk) => bugStatusLookup.get(bk) === BUG_REJECTED_STATUS);
    if (rejectedBug) {
      bugRejectedKeys.add(eaKey);
      bugRejectedDateLookup.set(eaKey, findStatusTransitionDate(bugTicketByKey.get(rejectedBug), BUG_REJECTED_STATUS));
    }
  }

  return {
    period: { label: periodLabel, start: startStr, end: endStr },
    eaTickets,
    eaByKey,
    gmStatus,
    sfRows,
    inPeriodEaKeys,
    allLinkedKeysFromSf,
    teoFilterKeys,
    eaToBugKeys,
    eaToPgKeys,
    eaToImprovementKeys,
    directBugKeys,
    bugRejectedKeys,
    linkedBugKeysByEa,
    bugStatusLookup,
    bugRejectedDateLookup,
    counts: {
      monthEasConcluded,
      monthEasInProgress,
      totalMonthEas: monthEasConcluded + monthEasInProgress,
      eaToBugNum: eaToBugKeys.size,
      eaToBugDen: monthEasConcluded,
      eaToBugDirectCount,
      eaToBugDuplicateCount,
      eaToPgNum: eaToPgKeys.size,
      eaToPgDen: monthEasConcluded,
      eaToImprovementNum: eaToImprovementKeys.size,
      eaToImprovementDen: monthEasConcluded,
      bugRejectionNum: bugRejectedKeys.size,
      bugRejectionDen: directBugKeys.size,
    },
  };
}

const rawCache = new Map(); // "year-month-types-products" -> { data, expiresAt }

async function getRawTeoData({ month, year, types, products }) {
  // Undefined (no Category/Product filter chips active) is kept distinct
  // from an explicit list, both in the key and in what's passed through to
  // fetchRawTeoData, so the default scope's cache entry is never confused
  // with a filtered one that happens to resolve to the same case set.
  const typesKey = types ? [...types].sort().join('|') : ' default';
  const productsKey = products ? [...products].sort().join('|') : ' default';
  const key = `${year}-${month}-${typesKey}-${productsKey}`;
  const cached = rawCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const data = await fetchRawTeoData({ month, year, types, products });
  rawCache.set(key, { data, expiresAt: Date.now() + RAW_CACHE_TTL_MS });
  return data;
}

// ── Layer 2: cheap, synchronous SF-cascaded recomputation ──────────────────
function pct(num, den) {
  return den ? num / den : 0;
}

function deriveFiltered(raw, { severities = [], pods = [], site = '' } = {}, podLookup = []) {
  const severitySet = severities.length ? new Set(severities.map((s) => `Severity ${s}`)) : null;
  const podSet = pods.length ? new Set(pods) : null;
  // Site comes from BigQuery's uptime_main.Site catalog, not Salesforce, so
  // this is a best-effort exact (case/whitespace-insensitive) match against
  // Account_Name__c rather than a guaranteed join.
  const siteNorm = site.trim().toLowerCase();

  const filteredRows = raw.sfRows.filter((row) => {
    if (severitySet && !severitySet.has(row.slaCategory)) return false;
    if (podSet) {
      const pod = accountPod(row.account, podLookup);
      if (!pod || !podSet.has(pod)) return false;
    }
    if (siteNorm && row.account.trim().toLowerCase() !== siteNorm) return false;
    return true;
  });

  const totalSf = filteredRows.length;
  const sfAnyGmLink = filteredRows.filter((r) => r.gmKeyRaw).length;
  const linkedRows = filteredRows.filter((r) => r.gmKey);
  const sfLinkedToGm = linkedRows.length;

  const allLinkedKeys = new Set(filteredRows.map((r) => r.gmKeyRaw).filter(Boolean));
  const inPeriodLinkedKeys = new Set([...raw.inPeriodEaKeys].filter((k) => allLinkedKeys.has(k)));
  const eaInPeriodLinkedToSf = inPeriodLinkedKeys.size;

  const oldEaKeys = new Set([...allLinkedKeys].filter((k) => !raw.inPeriodEaKeys.has(k)));
  const sfLinkedToOldEas = filteredRows.filter((r) => r.gmKeyRaw && oldEaKeys.has(r.gmKeyRaw)).length;

  const concludedFromTeoKeys = new Set([...inPeriodLinkedKeys].filter((k) => raw.teoFilterKeys.has(k)));
  const concludedFromQaKeys = new Set([...inPeriodLinkedKeys].filter((k) => !raw.teoFilterKeys.has(k)));
  const sfConcludedFromTeo = filteredRows.filter((r) => r.gmKeyRaw && concludedFromTeoKeys.has(r.gmKeyRaw)).length;
  const sfConcludedFromQa = filteredRows.filter((r) => r.gmKeyRaw && concludedFromQaKeys.has(r.gmKeyRaw)).length;

  const ticketToQaRows = filteredRows.filter((r) => r.gmKey && !raw.teoFilterKeys.has(r.gmKeyRaw));
  const sfTicketToQa = ticketToQaRows.length;

  const oldEasConcludedKeys = new Set([...oldEaKeys].filter((k) => raw.gmStatus.get(k)?.isConcludedV2));
  const oldEasInProgressKeys = new Set(
    [...oldEaKeys].filter((k) => raw.gmStatus.has(k) && !raw.gmStatus.get(k).isConcludedV2)
  );

  const totalMonthEas = raw.counts.totalMonthEas;

  const kpis = {
    ticketToGm: { pct: pct(sfAnyGmLink, totalSf), num: sfAnyGmLink, den: totalSf },
    ticketToTeo: {
      pct: pct(sfLinkedToGm, totalSf), num: sfLinkedToGm, den: totalSf,
      ea: { pct: pct(eaInPeriodLinkedToSf, totalMonthEas), num: eaInPeriodLinkedToSf, den: totalMonthEas },
    },
    ticketToQa: {
      pct: pct(sfTicketToQa, totalSf), num: sfTicketToQa, den: totalSf,
      ea: { pct: pct(concludedFromQaKeys.size, totalMonthEas), num: concludedFromQaKeys.size, den: totalMonthEas },
    },
    eaToBug: {
      pct: pct(raw.counts.eaToBugNum, raw.counts.eaToBugDen),
      num: raw.counts.eaToBugNum, den: raw.counts.eaToBugDen,
      directCount: raw.counts.eaToBugDirectCount, duplicateCount: raw.counts.eaToBugDuplicateCount,
    },
    bugRejection: {
      pct: pct(raw.counts.bugRejectionNum, raw.counts.bugRejectionDen),
      num: raw.counts.bugRejectionNum, den: raw.counts.bugRejectionDen,
    },
    eaToPg: {
      pct: pct(raw.counts.eaToPgNum, raw.counts.eaToPgDen),
      num: raw.counts.eaToPgNum, den: raw.counts.eaToPgDen,
    },
    eaToImprovements: {
      pct: pct(raw.counts.eaToImprovementNum, raw.counts.eaToImprovementDen),
      num: raw.counts.eaToImprovementNum, den: raw.counts.eaToImprovementDen,
    },
  };

  const bucketRows = [
    { label: 'Total SF Cases', sf: totalSf, gm: '—' },
    { label: 'SF — Any GM link / Unique EAs', sf: sfAnyGmLink, gm: allLinkedKeys.size },
    { label: 'SF Linked w/ Month EAs / Month EAs', sf: sfLinkedToGm, gm: eaInPeriodLinkedToSf },
    { label: 'SF Cases / EA — concluded from TEO', sf: sfConcludedFromTeo, gm: concludedFromTeoKeys.size },
    { label: 'SF Cases / EA reached to QA', sf: sfConcludedFromQa, gm: concludedFromQaKeys.size },
    { label: 'Month EAs — In Progress', sf: '—', gm: raw.counts.monthEasInProgress },
    { label: 'Month EAs — Concluded', sf: '—', gm: raw.counts.monthEasConcluded },
    { label: 'SF Linked w/ Old EAs / Old EAs', sf: sfLinkedToOldEas, gm: oldEaKeys.size },
    { label: 'Old EAs — In Progress', sf: '—', gm: oldEasInProgressKeys.size },
    { label: 'Old EAs — Concluded', sf: '—', gm: oldEasConcludedKeys.size },
  ];

  const pies = {
    sf: { month: sfLinkedToGm, old: sfLinkedToOldEas },
    gm: { month: eaInPeriodLinkedToSf, old: oldEaKeys.size },
  };

  return {
    kpis,
    bucket: { rows: bucketRows, pies },
    filteredRows,
    linkedRows,
    ticketToQaRows,
  };
}

// ── Drill-down row builders (feed the page's "View" expand panels) ─────────
function byCreatedDesc(a, b) {
  return new Date(b.createdDate || 0) - new Date(a.createdDate || 0);
}
function byResolutionDesc(a, b) {
  return new Date(b.resolutionDate || 0) - new Date(a.resolutionDate || 0);
}

function buildDrilldowns(raw, filtered) {
  const ticketGmRows = filtered.filteredRows
    .filter((r) => r.gmKeyRaw)
    .sort(byCreatedDesc)
    .slice(0, DRILLDOWN_ROW_CAP)
    .map((r) => [r.caseNumber, r.account, r.gmKeyRaw, r.product, fmtDate(r.createdDate)]);

  const ticketTeoRows = [...filtered.linkedRows]
    .sort(byCreatedDesc)
    .slice(0, DRILLDOWN_ROW_CAP)
    .map((r) => [r.caseNumber, r.account, r.gmKey, r.gmStatus, fmtDate(r.createdDate)]);

  const ticketQaRows = [...filtered.ticketToQaRows]
    .sort(byCreatedDesc)
    .slice(0, DRILLDOWN_ROW_CAP)
    .map((r) => [r.caseNumber, r.account, r.gmKey, r.gmStatus, fmtDate(r.createdDate)]);

  const eaBugEntries = [...raw.eaToBugKeys].map((k) => raw.gmStatus.get(k)).filter(Boolean);
  const eaBugRows = eaBugEntries
    .sort(byResolutionDesc)
    .slice(0, DRILLDOWN_ROW_CAP)
    .map((entry) => {
      const ticket = raw.eaByKey.get(entry.key);
      const bugs = ticket ? getLinkedBugs(ticket) : [];
      const isDirect = EA_BUG_KPI_RESOLUTIONS.has(entry.resolution);
      return [entry.key, bugs.join(', ') || '—', entry.resolution, isDirect ? 'Direct' : 'Duplicate chase', fmtDate(entry.resolutionDate)];
    });

  const bugRejectionRows = [...raw.bugRejectedKeys]
    .slice(0, DRILLDOWN_ROW_CAP)
    .map((k) => {
      const bugKeys = raw.linkedBugKeysByEa.get(k) || [];
      const rejectedBug = bugKeys.find((bk) => raw.bugStatusLookup.get(bk) === BUG_REJECTED_STATUS);
      return [k, rejectedBug || '—', fmtDate(raw.bugRejectedDateLookup.get(k))];
    });

  const eaPgEntries = [...raw.eaToPgKeys].map((k) => raw.gmStatus.get(k)).filter(Boolean);
  const eaPgRows = eaPgEntries
    .sort(byResolutionDesc)
    .slice(0, DRILLDOWN_ROW_CAP)
    .map((entry) => [entry.key, entry.resolution, fmtDate(entry.resolutionDate)]);

  const eaImprovementEntries = [...raw.eaToImprovementKeys].map((k) => raw.gmStatus.get(k)).filter(Boolean);
  const eaImprovementRows = eaImprovementEntries
    .sort(byResolutionDesc)
    .slice(0, DRILLDOWN_ROW_CAP)
    .map((entry) => [entry.key, raw.eaToBugKeys.has(entry.key) ? 'Bug' : 'Process Gap', fmtDate(entry.resolutionDate)]);

  return {
    'ticket-gm': {
      title: 'Ticket → GM — any-GM-link cases',
      subtitle: `Showing ${ticketGmRows.length} of ${filtered.kpis.ticketToGm.num} SF cases linked to any GM-XXX EA`,
      columns: ['Case #', 'Account', 'Linked EA', 'Product', 'Created'],
      rows: ticketGmRows,
    },
    'ticket-teo': {
      title: 'Ticket → TEO — period-linked cases',
      subtitle: `Showing ${ticketTeoRows.length} of ${filtered.kpis.ticketToTeo.num} SF cases linked to a Month EA`,
      columns: ['Case #', 'Account', 'Linked EA', 'EA Status', 'Created'],
      rows: ticketTeoRows,
    },
    'ticket-qa': {
      title: 'Ticket → QA — Ticket→QA cases',
      subtitle: `Showing ${ticketQaRows.length} of ${filtered.kpis.ticketToQa.num} SF cases whose linked EA reached QA (not TEO-resolved)`,
      columns: ['Case #', 'Account', 'Linked EA', 'EA Status', 'Created'],
      rows: ticketQaRows,
    },
    'ea-bug': {
      title: 'EA → Bug — EAs concluded as Known/New Bug',
      subtitle: `Showing ${eaBugRows.length} of ${filtered.kpis.eaToBug.num} Month EAs concluded as Known/New Bug`,
      columns: ['EA', 'Linked Bug(s)', 'Resolution', 'Resolution Path', 'Concluded On'],
      rows: eaBugRows,
    },
    'bug-rejection': {
      title: 'Bug Rejection % — EAs w/ Rejected linked Bug',
      subtitle: `Showing all ${bugRejectionRows.length} of ${filtered.kpis.bugRejection.num} EAs whose direct Known/New Bug was rejected`,
      columns: ['EA', 'Bug ID', 'Rejected On'],
      rows: bugRejectionRows,
    },
    'ea-pg': {
      title: 'EA → PG — EAs concluded as Process Gap',
      subtitle: `Showing ${eaPgRows.length} of ${filtered.kpis.eaToPg.num} Month EAs concluded as Process Gap`,
      columns: ['EA', 'Resolution', 'Concluded On'],
      rows: eaPgRows,
    },
    'ea-improvements': {
      title: 'EA → Improvements — Bug ∪ Process Gap',
      subtitle: `Showing ${eaImprovementRows.length} of ${filtered.kpis.eaToImprovements.num} Month EAs concluded as Bug or Process Gap`,
      columns: ['EA', 'Outcome', 'Concluded On'],
      rows: eaImprovementRows,
    },
  };
}

// ── Public entry point ──────────────────────────────────────────────────────
export async function computeTeoKpis({ month, year, severities = [], pods = [], types, products, site = '' }) {
  const raw = await getRawTeoData({ month, year, types, products });
  const podMap = await getPodMap();
  const podLookup = buildPodLookup(podMap);
  const filtered = deriveFiltered(raw, { severities, pods, site }, podLookup);
  const drilldowns = buildDrilldowns(raw, filtered);
  return {
    period: raw.period,
    kpis: filtered.kpis,
    bucket: filtered.bucket,
    drilldowns,
  };
}
