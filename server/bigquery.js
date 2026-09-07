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
const MTBF_TABLE = `\`${GCLOUD_PROJECT_ID}.sw_support_v1.uptime_main_Latest\``;

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

async function runQuery(query, params) {
  const [rows] = await bigquery.query({ query, params });
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

// uptime_main is grained by Date/Site/Product, so a site's daily uptime is
// derived by summing Operations_hr and Software_Downtime_hr across its
// products first. A site with zero recorded operations that day has no
// uptime figure and is dropped rather than divided by zero.
function uptimePct(opsHr, downtimeHr) {
  return opsHr > 0 ? ((opsHr - downtimeHr) / opsHr) * 100 : null;
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
      SUM(IFNULL(Software_Downtime_hr, 0)) AS downtime_hr
    FROM ${UPTIME_TABLE}
    WHERE Date BETWEEN @weekStart AND @weekEnd ${where}
    GROUP BY Site
  `, { weekStart, weekEnd, ...params });
  const snapshot = snapshotRows
    .map((r) => ({
      name: r.name,
      threshold: r.threshold || 'N/A',
      pct: uptimePct(Number(r.ops_hr), Number(r.downtime_hr)),
    }))
    .filter((r) => r.pct !== null)
    .sort((a, b) => b.pct - a.pct);

  const weeklyRows = await runQuery(`
    SELECT
      Week_Start_Date AS week_start,
      ANY_VALUE(Week_Num) AS week,
      Site,
      SUM(Operations_hr) AS ops_hr,
      SUM(IFNULL(Software_Downtime_hr, 0)) AS downtime_hr
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
    const pct = uptimePct(Number(r.ops_hr), Number(r.downtime_hr));
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
      SUM(SW_Sev1_2_3_Count) AS sev_count
    FROM ${MTBF_TABLE}
    WHERE Week_Start_Date = @weekStart ${where}
    GROUP BY Site
  `, { weekStart, ...params });
  // Sites with zero operating hours in the week have no meaningful MTBF
  // (nothing to divide by, and mtbfHours would otherwise report them as 0h),
  // so they're excluded from the site list, pie, and overall figure.
  const activeRows = snapshotRows.filter((r) => Number(r.ops_hr) > 0);
  const snapshot = activeRows
    .map((r) => ({
      name: r.name,
      threshold: r.threshold || 'N/A',
      hours: mtbfHours(Number(r.ops_hr), Number(r.sev_count)),
    }))
    .sort((a, b) => a.hours - b.hours);
  const overall = mtbfHours(
    activeRows.reduce((sum, r) => sum + Number(r.ops_hr), 0),
    activeRows.reduce((sum, r) => sum + Number(r.sev_count), 0),
  );

  const weeklyRows = await runQuery(`
    SELECT
      t.Week_Start_Date AS week_start,
      t.Week_Num AS week,
      t.Site AS site,
      SUM(t.Operations_hr) AS ops_hr,
      SUM(t.SW_Sev1_2_3_Count) AS sev_count
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
    const opsHr = Number(r.ops_hr);
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

function mtbfHours(opsHr, sevCount) {
  return sevCount > 0 ? opsHr / sevCount : opsHr;
}
