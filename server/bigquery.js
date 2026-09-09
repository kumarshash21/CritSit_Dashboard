// BigQuery client for the Software Stability page's Uptime and MTBF panels.
// Both read from sw_support_v1, refreshed daily. uptime_main is grained by
// Date/Site/Product (Operations_hr, Software_Downtime_hr per row), so uptime
// % is derived rather than stored; uptime_main_Latest is pre-aggregated to
// Week_Start_Date/Site and is the only table carrying SW_Sev1_2_3_Count.
import { BigQuery } from '@google-cloud/bigquery';

const { GCLOUD_PROJECT_ID } = process.env;

if (!GCLOUD_PROJECT_ID) throw new Error('Missing required env var: GCLOUD_PROJECT_ID');

const bigquery = new BigQuery({ projectId: GCLOUD_PROJECT_ID });

const UPTIME_TABLE = `\`${GCLOUD_PROJECT_ID}.sw_support_v1.uptime_main\``;
const MTBF_TABLE = `\`${GCLOUD_PROJECT_ID}.sw_support_v1.uptime_main\``;

// Ticket-level Zendesk data for the Ticket Inflow/Backlog Health panels — one
// row per ticket, refreshed daily. Ticket_Solved_IST is unset for a
// meaningful slice of already-solved/closed tickets (an ETL gap, not a sign
// they're still open), so it's only trustworthy for "was this ticket solved
// inside this specific window" checks (SLA) — never for reconstructing
// whether a ticket was still open as of some past week.
const TICKET_TABLE = `\`${GCLOUD_PROJECT_ID}.sw_support_v1.uptime_main\``;

// Same thresholds as the frontend's classifyUptime/classifyMtbf
// (public/software-stability.html) — kept in sync manually, there's no
// shared module between server and static HTML.
function classifyUptime(pct) {
  if (pct > 99.8) return 'green';
  if (pct > 99.4) return 'yellow';
  return 'red';
}

function classifyMtbf(hours) {
  if (hours < 24) return 'red';
  if (hours < 36) return 'yellow';
  return 'green';
}

async function runQuery(query, params, types) {
  const [rows] = await bigquery.query({ query, params, types });
  return rows;
}

function bucketPercentages(values, classify) {
  const buckets = { red: 0, yellow: 0, green: 0 };
  for (const v of values) buckets[classify(v)] += 1;
  const total = values.length || 1;
  return {
    redPct: (buckets.red / total) * 100,
    yellowPct: (buckets.yellow / total) * 100,
    greenPct: (buckets.green / total) * 100,
  };
}

// uptime_main is grained by Date/Site/Product. For a multi-product site,
// uptime is not simply (sum of ops - sum of downtime) / sum of ops: that
// treats the site's total operating hours as one pool, when each product
// actually runs its own hours in parallel. Instead we average the per-product
// operating hours into one representative "site ops hr" (sum of ops_hr /
// number of products) and measure the site's total downtime against that. A
// site with zero recorded operations has no uptime figure and is dropped
// rather than divided by zero.
function uptimePct(opsHr, downtimeHr, numProducts) {
  const avgOpsHr = numProducts > 0 ? opsHr / numProducts : 0;
  return avgOpsHr > 0 ? ((avgOpsHr - downtimeHr) / avgOpsHr) * 100 : null;
}

// Builds an "AND Site IN UNNEST(@sites) AND Product IN UNNEST(@products)"
// fragment plus the matching query params, omitting each half (and its
// param) when that filter is empty — an empty array param plus an unused
// UNNEST reference is worth avoiding rather than relying on BigQuery to
// tolerate it.
function siteProductFilter(sites, products) {
  const clauses = [];
  const params = {};
  if (sites.length) { clauses.push('Site IN UNNEST(@sites)'); params.sites = sites; }
  if (products.length) { clauses.push('Product IN UNNEST(@products)'); params.products = products; }
  return { where: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

async function resolveWeekAnchor(table, year, week, { completedOnly = false } = {}) {
  if (year && week) {
    const rows = await runQuery(`
      SELECT Week_Start_Date, Week_End_Date, Week_Num AS week, Year AS year
      FROM ${table}
      WHERE Year = @year AND Week_Num = @week
      GROUP BY Week_Start_Date, Week_End_Date, Week_Num, Year
      LIMIT 1
    `, { year, week });
    if (rows.length) return rows[0];
  }
  const rows = await runQuery(`
    SELECT Week_Start_Date, Week_End_Date, Week_Num AS week, Year AS year
    FROM ${table}
    ${completedOnly ? 'WHERE Week_End_Date < CURRENT_DATE()' : ''}
    GROUP BY Week_Start_Date, Week_End_Date, Week_Num, Year
    ORDER BY Week_Start_Date DESC
    LIMIT 1
  `);
  return rows[0];
}

// year/week select which week's snapshot to show (defaults to the latest
// available week); sites/products narrow both the snapshot and the 6-week
// trend down to the selected Site/Product-Type filter chips.
export async function getUptimeData({ year, week, sites = [], products = [] } = {}) {
  const anchor = await resolveWeekAnchor(UPTIME_TABLE, year, week);
  if (!anchor) return { snapshot: [], weekly: [], selectedWeek: null };
  const weekStart = anchor.Week_Start_Date.value;
  const weekEnd = anchor.Week_End_Date.value;
  const { where, params } = siteProductFilter(sites, products);

  const snapshotRows = await runQuery(`
    SELECT
      Site AS name,
      ANY_VALUE(Saas_Site) AS threshold,
      SUM(Operations_hr) AS ops_hr,
      SUM(IFNULL(Software_Downtime_hr, 0)) AS downtime_hr,
      COUNT(DISTINCT Product) AS num_products
    FROM ${UPTIME_TABLE}
    WHERE Date BETWEEN @weekStart AND @weekEnd ${where}
    GROUP BY Site
  `, { weekStart, weekEnd, ...params });
  const snapshot = snapshotRows
    .map((r) => ({
      name: r.name,
      threshold: r.threshold || 'N/A',
      pct: uptimePct(Number(r.ops_hr), Number(r.downtime_hr), Number(r.num_products)),
    }))
    .filter((r) => r.pct !== null)
    .sort((a, b) => b.pct - a.pct);

  const weeklyRows = await runQuery(`
    SELECT
      Week_Start_Date AS week_start,
      ANY_VALUE(Week_Num) AS week,
      Site,
      SUM(Operations_hr) AS ops_hr,
      SUM(IFNULL(Software_Downtime_hr, 0)) AS downtime_hr,
      COUNT(DISTINCT Product) AS num_products
    FROM ${UPTIME_TABLE}
    WHERE Week_Start_Date IN (
      SELECT DISTINCT Week_Start_Date FROM ${UPTIME_TABLE}
      WHERE Week_Start_Date <= @weekStart
      ORDER BY Week_Start_Date DESC LIMIT 6
    ) ${where}
    GROUP BY Week_Start_Date, Site
  `, { weekStart, ...params });
  const byWeek = new Map();
  for (const r of weeklyRows) {
    const pct = uptimePct(Number(r.ops_hr), Number(r.downtime_hr), Number(r.num_products));
    if (pct === null) continue;
    const key = r.week_start.value;
    if (!byWeek.has(key)) byWeek.set(key, { week: r.week, pcts: [] });
    byWeek.get(key).pcts.push(pct);
  }
  const weekly = [...byWeek.keys()]
    .sort()
    .map((dateKey) => {
      const { week, pcts } = byWeek.get(dateKey);
      const uptimePctAvg = pcts.reduce((sum, v) => sum + v, 0) / pcts.length;
      return { week, uptimePct: uptimePctAvg, ...bucketPercentages(pcts, classifyUptime) };
    });

  return { snapshot, weekly, selectedWeek: { year: anchor.year, week: anchor.week, start: weekStart, end: weekEnd } };
}

export async function getMtbfData({ year, week, sites = [], products = [] } = {}) {
  // With no explicit week requested, fall back to the latest *completed*
  // week (excludes the current in-progress week) — matches the original
  // default behavior. An explicit year/week is honored even if in progress.
  const anchor = await resolveWeekAnchor(MTBF_TABLE, year, week, { completedOnly: !(year && week) });
  if (!anchor) return { snapshot: [], overall: 0, weekly: [], selectedWeek: null };
  const weekStart = anchor.Week_Start_Date.value;
  const { where, params } = siteProductFilter(sites, products);

  const snapshotRows = await runQuery(`
    SELECT
      Site AS name,
      ANY_VALUE(Saas_Site) AS threshold,
      SUM(Operations_hr) AS ops_hr,
      SUM(SW_Sev1_2_3_Count) AS sev_count,
      COUNT(DISTINCT Product) AS num_products
    FROM ${MTBF_TABLE}
    WHERE Week_Start_Date = @weekStart ${where}
    GROUP BY Site
  `, { weekStart, ...params });
  // Sites with zero operating hours in the week have no meaningful MTBF
  // (nothing to divide by, and mtbfHours would otherwise report them as 0h),
  // so they're excluded from the site list, pie, and overall figure. Ops
  // hours are averaged across the site's products first (same reasoning as
  // uptimePct's avgOpsHr: a multi-product site's products run their hours in
  // parallel, so raw SUM(Operations_hr) would double-count them), while
  // severities stay a straight sum across products.
  const activeRows = snapshotRows
    .map((r) => ({
      name: r.name,
      threshold: r.threshold || 'N/A',
      opsHr: avgOpsHr(Number(r.ops_hr), Number(r.num_products)),
      sevCount: Number(r.sev_count),
    }))
    .filter((r) => r.opsHr > 0);
  const snapshot = activeRows
    .map((r) => ({
      name: r.name,
      threshold: r.threshold,
      hours: mtbfHours(r.opsHr, r.sevCount),
    }))
    .sort((a, b) => a.hours - b.hours);
  const overall = mtbfHours(
    activeRows.reduce((sum, r) => sum + r.opsHr, 0),
    activeRows.reduce((sum, r) => sum + r.sevCount, 0),
  );

  const weeklyRows = await runQuery(`
    SELECT
      t.Week_Start_Date AS week_start,
      t.Week_Num AS week,
      t.Site AS site,
      SUM(t.Operations_hr) AS ops_hr,
      SUM(t.SW_Sev1_2_3_Count) AS sev_count,
      COUNT(DISTINCT t.Product) AS num_products
    FROM ${MTBF_TABLE} t
    JOIN (
      SELECT DISTINCT Week_Start_Date
      FROM ${MTBF_TABLE}
      WHERE Week_Start_Date <= @weekStart
      ORDER BY Week_Start_Date DESC
      LIMIT 6
    ) w ON t.Week_Start_Date = w.Week_Start_Date
    WHERE TRUE ${where}
    GROUP BY week_start, week, site
  `, { weekStart, ...params });
  const byWeek = new Map();
  for (const r of weeklyRows) {
    const opsHr = avgOpsHr(Number(r.ops_hr), Number(r.num_products));
    if (opsHr <= 0) continue; // no operating hours that week => no MTBF to count for this site
    const key = r.week_start.value;
    if (!byWeek.has(key)) byWeek.set(key, { week: r.week, opsHr: 0, sevCount: 0, hoursBySite: [] });
    const entry = byWeek.get(key);
    const sevCount = Number(r.sev_count);
    entry.opsHr += opsHr;
    entry.sevCount += sevCount;
    entry.hoursBySite.push(mtbfHours(opsHr, sevCount));
  }
  const weekly = [...byWeek.keys()]
    .sort()
    .map((weekStartKey) => {
      const { week, opsHr, sevCount, hoursBySite } = byWeek.get(weekStartKey);
      return { week, mtbf: mtbfHours(opsHr, sevCount), ...bucketPercentages(hoursBySite, classifyMtbf) };
    });

  return { snapshot, overall, weekly, selectedWeek: { year: anchor.year, week: anchor.week, start: weekStart } };
}

// Resolves a Select-Week filter value (year/week, or the latest week when
// omitted) to its actual calendar date range — the same anchor getUptimeData
// uses — so the SF/Jira-backed KPI route can scope its date filtering to the
// exact same week boundaries shown in the Uptime/MTBF panels.
export async function getWeekDateRange({ year, week } = {}) {
  const anchor = await resolveWeekAnchor(UPTIME_TABLE, year, week);
  if (!anchor) return null;
  return {
    year: anchor.year,
    week: anchor.week,
    start: anchor.Week_Start_Date.value,
    end: anchor.Week_End_Date.value,
  };
}

function toUtcDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`);
}
function fmtUtcDate(d) {
  return d.toISOString().slice(0, 10);
}

// Resolves the "KPI Month" filter to full-week boundaries instead of plain
// calendar days: a week is assigned to whichever calendar month contains the
// majority (4+) of its 7 days, so a week straddling a month boundary (e.g.
// Aug 31 - Sep 6) counts toward whichever side owns most of it. The returned
// range is the first such week's start through the last such week's end —
// e.g. September might resolve to something like Week 36 through Week 40,
// never splitting a week across the KPI Month and its neighbor. Returns null
// when BigQuery has no week rows covering the requested month yet.
export async function getMonthWeekRange({ year, month } = {}) {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 0)); // last day of month, UTC midnight
  const queryStart = new Date(monthStart.getTime() - 7 * 24 * 3600 * 1000);
  const queryEnd = new Date(monthEnd.getTime() + 7 * 24 * 3600 * 1000);

  const rows = await runQuery(`
    SELECT Week_Start_Date, Week_End_Date, Week_Num AS week, Year AS year
    FROM ${UPTIME_TABLE}
    WHERE Week_Start_Date <= @queryEnd AND Week_End_Date >= @queryStart
    GROUP BY Week_Start_Date, Week_End_Date, Week_Num, Year
    ORDER BY Week_Start_Date ASC
  `, { queryStart: fmtUtcDate(queryStart), queryEnd: fmtUtcDate(queryEnd) });
  if (!rows.length) return null;

  const DAY_MS = 24 * 3600 * 1000;
  const monthStartMs = monthStart.getTime();
  const monthEndMs = monthEnd.getTime();
  const weeksInMonth = rows.filter((r) => {
    const wStartMs = toUtcDate(r.Week_Start_Date.value).getTime();
    const wEndMs = toUtcDate(r.Week_End_Date.value).getTime();
    let daysInMonth = 0;
    for (let t = wStartMs; t <= wEndMs; t += DAY_MS) {
      if (t >= monthStartMs && t <= monthEndMs) daysInMonth += 1;
    }
    return daysInMonth >= 4;
  });
  if (!weeksInMonth.length) return null;

  const first = weeksInMonth[0];
  const last = weeksInMonth[weeksInMonth.length - 1];
  return {
    start: first.Week_Start_Date.value,
    end: last.Week_End_Date.value,
    weeks: weeksInMonth.map((r) => ({ year: r.year, week: r.week })),
  };
}

let siteCache = null; // { data, expiresAt }
const SITE_CACHE_TTL_MS = 10 * 60 * 1000;

// Full distinct Site catalog, cached — used both for the Site filter dropdown
// and to resolve which sites belong to a selected POD (see podMap.js).
export async function getAllSites() {
  if (siteCache && siteCache.expiresAt > Date.now()) return siteCache.data;
  const siteRows = await runQuery(`SELECT DISTINCT Site AS name FROM ${UPTIME_TABLE} ORDER BY name`);
  const data = siteRows.map((r) => r.name);
  siteCache = { data, expiresAt: Date.now() + SITE_CACHE_TTL_MS };
  return data;
}

// Populates the Software Stability page's "Select Week" and "Site" filter
// dropdowns straight from the live table, so they never drift from what's
// actually queryable.
export async function getStabilityFilterOptions() {
  const weekRows = await runQuery(`
    SELECT Year AS year, Week_Num AS week, Week_Start_Date AS week_start, Week_End_Date AS week_end
    FROM ${UPTIME_TABLE}
    GROUP BY year, week, week_start, week_end
    ORDER BY week_start DESC
    LIMIT 26
  `);
  const weeks = weekRows.map((r) => ({
    year: r.year,
    week: r.week,
    start: r.week_start.value,
    end: r.week_end.value,
  }));

  const sites = await getAllSites();

  return { weeks, sites };
}

// Same parallel-hours reasoning as uptimePct's avgOpsHr: a multi-product
// site's products each run their own operating hours, so this averages them
// into one representative site-level ops-hour figure instead of pooling them.
function avgOpsHr(opsHr, numProducts) {
  return numProducts > 0 ? opsHr / numProducts : 0;
}

function mtbfHours(opsHr, sevCount) {
  return sevCount > 0 ? opsHr / sevCount : opsHr;
}

// ---- Ticket Inflow / Backlog Health (zendesk_tkts.zendesk_recent_standard_v1) ----

const TICKET_TREND_WEEKS = 13; // matches the page's Ticket Inflow/Backlog trend charts

// Both panels share the page's established BigQuery scope for this page
// (Type = Incident, software tickets only); Site/Product/Severity narrow
// further. Site values line up with uptime_main.Site (Standard_Site_Name is
// the same vocabulary, verified against getAllSites()), so the existing
// Site/POD filters apply unchanged.
function ticketFilter(sites, products, severities) {
  const clauses = [`Label = 'Software'`, `Type___Sub_Category = 'Incident'`];
  const params = {};
  if (sites.length) { clauses.push('Standard_Site_Name IN UNNEST(@tSites)'); params.tSites = sites; }
  if (products.length) { clauses.push('Product_Type IN UNNEST(@tProducts)'); params.tProducts = products; }
  if (severities.length) { clauses.push('SLA_Category IN UNNEST(@tSeverities)'); params.tSeverities = severities; }
  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

// TIMESTAMP_DIFF/comparisons need a real timestamp boundary, not the bare
// DATE uptime_main stores — end is treated as inclusive-through-end-of-day.
function tsBounds(weekStart, weekEnd) {
  return { startTs: `${weekStart} 00:00:00`, endTs: `${weekEnd} 23:59:59.999999` };
}

// The last `limit` weeks up to and including anchorWeekStart, oldest first —
// same Year/Week_Num/date grain as the Select-Week filter and the Uptime/MTBF
// trend charts, so all of the page's BigQuery-backed sections agree on week
// boundaries.
async function getRecentWeekBoundaries(anchorWeekStart, limit) {
  const rows = await runQuery(`
    SELECT Week_Start_Date, Week_End_Date, Week_Num AS week, Year AS year
    FROM ${UPTIME_TABLE}
    WHERE Week_Start_Date <= @anchorWeekStart
    GROUP BY Week_Start_Date, Week_End_Date, Week_Num, Year
    ORDER BY Week_Start_Date DESC
    LIMIT @limit
  `, { anchorWeekStart, limit });
  return rows
    .map((r) => ({ start: r.Week_Start_Date.value, end: r.Week_End_Date.value, week: r.week, year: r.year }))
    .reverse();
}

function wowPct(current, previous) {
  if (previous > 0) return ((current - previous) / previous) * 100;
  return current > 0 ? null : 0; // null => "new" (nothing to compare against)
}

// year/week/sites/products behave like getUptimeData/getMtbfData; severities
// (SLA_Category values, e.g. "Severity 1") is this panel's own Severity-tab
// filter, independent of the page's Severity filter chips (those only affect
// the SF/Jira-backed KPI cards below).
export async function getTicketInflowData({ year, week, sites = [], products = [], severities = [] } = {}) {
  // Defaults to the latest *completed* week (like getMtbfData) — otherwise an
  // in-progress current week reads as a misleading drop in ticket inflow.
  const anchor = await resolveWeekAnchor(UPTIME_TABLE, year, week, { completedOnly: !(year && week) });
  if (!anchor) return { trend: [], sitewise: [], headline: { count: 0, wowPct: null, prevMa: 0 }, selectedWeek: null };
  const weekStart = anchor.Week_Start_Date.value;
  const weekEnd = anchor.Week_End_Date.value;
  const weeks = await getRecentWeekBoundaries(weekStart, TICKET_TREND_WEEKS);
  const { where, params } = ticketFilter(sites, products, severities);

  const trend = await Promise.all(weeks.map(async (wk) => {
    const { startTs, endTs } = tsBounds(wk.start, wk.end);
    const rows = await runQuery(`
      SELECT COUNT(*) AS cnt
      FROM ${TICKET_TABLE}
      ${where} AND Ticket_Created_IST BETWEEN @startTs AND @endTs
    `, { ...params, startTs, endTs });
    return { week: wk.week, year: wk.year, count: Number(rows[0].cnt) };
  }));

  // Sitewise: anchor week vs the week before it, for each site's WoW % change.
  const { startTs, endTs } = tsBounds(weekStart, weekEnd);
  const sitewiseRows = await runQuery(`
    SELECT Standard_Site_Name AS name, COUNT(*) AS cnt
    FROM ${TICKET_TABLE}
    ${where} AND Ticket_Created_IST BETWEEN @startTs AND @endTs AND Standard_Site_Name IS NOT NULL
    GROUP BY name
  `, { ...params, startTs, endTs });

  const prevWeek = weeks.length >= 2 ? weeks[weeks.length - 2] : null;
  let prevBySite = new Map();
  if (prevWeek) {
    const prevBounds = tsBounds(prevWeek.start, prevWeek.end);
    const prevRows = await runQuery(`
      SELECT Standard_Site_Name AS name, COUNT(*) AS cnt
      FROM ${TICKET_TABLE}
      ${where} AND Ticket_Created_IST BETWEEN @startTs AND @endTs AND Standard_Site_Name IS NOT NULL
      GROUP BY name
    `, { ...params, ...prevBounds });
    prevBySite = new Map(prevRows.map((r) => [r.name, Number(r.cnt)]));
  }

  const sitewise = sitewiseRows
    .map((r) => {
      const count = Number(r.cnt);
      const prev = prevBySite.get(r.name) || 0;
      return { name: r.name, count, pctChange: wowPct(count, prev) };
    })
    .sort((a, b) => b.count - a.count);

  const totalCount = trend.length ? trend[trend.length - 1].count : 0;
  const prevTotal = trend.length >= 2 ? trend[trend.length - 2].count : 0;
  const prior4 = trend.slice(-5, -1);
  const prevMa = prior4.length ? prior4.reduce((sum, w) => sum + w.count, 0) / prior4.length : 0;

  return {
    trend,
    sitewise,
    headline: { count: totalCount, wowPct: wowPct(totalCount, prevTotal), prevMa },
    selectedWeek: { year: anchor.year, week: anchor.week, start: weekStart, end: weekEnd },
  };
}

// Fixed to Severity 1-3 — mirrors the "(Sev 1,2,3)" tiles in
// public/Support Performance KPI.xlsx, not the panel's own Severity-tab
// filter (Ticket Inflow's tabs and this fixed scope are independent).
const SLA_AGING_SEVERITIES = ['Severity 1', 'Severity 2', 'Severity 3'];

// Ticket_Solved_IST can't be trusted on its own: it's unset for ~13% of
// already-solved/closed software incidents (an ETL gap), AND it stays
// populated with a stale value on tickets that were later reopened — a
// currently-open ticket can still show a past Ticket_Solved_IST. So it's only
// consulted when the ticket's *current* status actually is Solved/Closed;
// Ticket_updated___Timestamp (always populated) covers the ETL gap for those.
// A currently-open ticket always gets NULL here, i.e. counted as backlog for
// every week up to now — the only assumption possible without a real
// status-history table.
const EFFECTIVE_SOLVED_AT = `IF(Ticket_status IN ('Solved', 'Closed'), COALESCE(Ticket_Solved_IST, Ticket_updated___Timestamp), NULL)`;

// year/week/sites/products behave like getUptimeData/getMtbfData. No
// Severity-tab equivalent here — the section has none in the design; the SLA
// and Aging tiles are hardcoded to Sev 1-3 regardless of Site/Product filters.
export async function getTicketBacklogData({ year, week, sites = [], products = [] } = {}) {
  // Same latest-completed-week default as getTicketInflowData — keeps the SLA
  // Achieved % sample (tickets solved within the week) from being skewed by a
  // still-in-progress week.
  const anchor = await resolveWeekAnchor(UPTIME_TABLE, year, week, { completedOnly: !(year && week) });
  if (!anchor) {
    return {
      trend: [], sitewise: [], status: [],
      headline: { count: 0, wowPct: null }, sla: { pct: null, within: 0, total: 0 }, agingDays: null,
      selectedWeek: null,
    };
  }
  const weekStart = anchor.Week_Start_Date.value;
  const weekEnd = anchor.Week_End_Date.value;
  const weeks = await getRecentWeekBoundaries(weekStart, TICKET_TREND_WEEKS);
  const { where, params } = ticketFilter(sites, products, []);

  // Overall Tickets Backlog trend: point-in-time open count as of each week's
  // end, reconstructed from creation + effective-solved timestamps (created
  // by then, and either still unsolved or solved after that week ended).
  const trend = await Promise.all(weeks.map(async (wk) => {
    const { endTs } = tsBounds(wk.start, wk.end);
    const rows = await runQuery(`
      SELECT COUNT(*) AS cnt
      FROM ${TICKET_TABLE}
      ${where} AND Ticket_Created_IST <= @endTs
        AND (${EFFECTIVE_SOLVED_AT} IS NULL OR ${EFFECTIVE_SOLVED_AT} > @endTs)
    `, { ...params, endTs });
    return { week: wk.week, year: wk.year, count: Number(rows[0].cnt) };
  }));

  const { startTs, endTs } = tsBounds(weekStart, weekEnd);

  // SLA Achieved % (Sev 1,2,3): of tickets solved within the selected week,
  // share resolved inside the severity-specific target — the "Within SLA"
  // rule from Support Performance KPI.xlsx (Solved_Ticket sheet):
  //   Sev1: resolved <= 60 min
  //   Sev2: resolved <= 60 min if >=50% systems affected, else <= 120 min
  //   Sev3: resolved <= 1440 min (24h)
  // Only tickets with a real Ticket_Solved_IST land in this window, so the
  // NULL-solved-timestamp gap noted above doesn't affect this metric.
  const { where: slaWhere, params: slaParams } = ticketFilter(sites, products, SLA_AGING_SEVERITIES);
  const slaRows = await runQuery(`
    SELECT
      COUNTIF(
        (SLA_Category = 'Severity 1' AND Resolution_Time__In_Min_ <= 60)
        OR (SLA_Category = 'Severity 2' AND System_Affected_____0_100_ >= 50 AND Resolution_Time__In_Min_ <= 60)
        OR (SLA_Category = 'Severity 2' AND (System_Affected_____0_100_ < 50 OR System_Affected_____0_100_ IS NULL) AND Resolution_Time__In_Min_ <= 120)
        OR (SLA_Category = 'Severity 3' AND Resolution_Time__In_Min_ <= 1440)
      ) AS withinCount,
      COUNT(*) AS total
    FROM ${TICKET_TABLE}
    ${slaWhere} AND Ticket_Solved_IST BETWEEN @startTs AND @endTs
  `, { ...slaParams, startTs, endTs });
  const slaTotal = Number(slaRows[0]?.total || 0);
  const slaWithin = Number(slaRows[0]?.withinCount || 0);

  // Ticket Avg. Aging (Days) (Sev 1,2,3) + Status + Sitewise BL Aging Analysis
  // all read TICKET_TABLE's *current* Ticket_status directly (reliable — it's
  // just today's field value, not a historical reconstruction), so all three
  // always reflect "now" rather than the selected week.
  const { where: openWhere, params: openParams } = ticketFilter(sites, products, SLA_AGING_SEVERITIES);
  const agingRows = await runQuery(`
    SELECT AVG(TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), Ticket_Created_IST, HOUR)) / 24.0 AS avgDays, COUNT(*) AS cnt
    FROM ${TICKET_TABLE}
    ${openWhere} AND Ticket_status NOT IN ('Solved', 'Closed')
  `, openParams);
  const agingDays = Number(agingRows[0]?.cnt || 0) > 0 ? Number(agingRows[0].avgDays) : null;

  const statusRows = await runQuery(`
    SELECT Ticket_status AS status, COUNT(*) AS cnt
    FROM ${TICKET_TABLE}
    ${where} AND Ticket_status NOT IN ('Solved', 'Closed')
    GROUP BY status
    ORDER BY cnt DESC
  `, params);
  const status = statusRows.map((r) => ({ status: r.status || 'Unknown', count: Number(r.cnt) }));

  const sitewiseRows = await runQuery(`
    SELECT
      Standard_Site_Name AS name,
      COUNT(*) AS cnt,
      AVG(TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), Ticket_Created_IST, HOUR)) / 24.0 AS avgDays
    FROM ${TICKET_TABLE}
    ${where} AND Ticket_status NOT IN ('Solved', 'Closed') AND Standard_Site_Name IS NOT NULL
    GROUP BY name
  `, params);
  const sitewise = sitewiseRows
    .map((r) => ({ name: r.name, count: Number(r.cnt), agingDays: Number(r.avgDays) }))
    .sort((a, b) => b.count - a.count);

  const overallCount = trend.length ? trend[trend.length - 1].count : 0;
  const prevOverall = trend.length >= 2 ? trend[trend.length - 2].count : 0;

  return {
    trend,
    sitewise,
    status,
    headline: { count: overallCount, wowPct: wowPct(overallCount, prevOverall) },
    sla: { pct: slaTotal > 0 ? (slaWithin / slaTotal) * 100 : null, within: slaWithin, total: slaTotal },
    agingDays,
    selectedWeek: { year: anchor.year, week: anchor.week, start: weekStart, end: weekEnd },
  };
}
