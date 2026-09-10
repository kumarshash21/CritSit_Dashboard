import { dayKeyInZone, zonedMidnightUtc } from './tz.js';

const {
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_INSTANCE_URL,
  SF_API_VERSION = 'v60.0',
} = process.env;

for (const [key, value] of Object.entries({ SF_CLIENT_ID, SF_CLIENT_SECRET, SF_INSTANCE_URL })) {
  if (!value) throw new Error(`Missing required env var: ${key}`);
}

let cachedToken = null; // { accessToken, instanceUrl }

async function authenticate() {
  const url = `${SF_INSTANCE_URL}/services/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce authentication failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = { accessToken: data.access_token, instanceUrl: data.instance_url };
  console.log('[salesforce] authenticated successfully');
  return cachedToken;
}

async function getToken() {
  if (!cachedToken) await authenticate();
  return cachedToken;
}

async function sfFetch(path, { retry = true } = {}) {
  const token = await getToken();
  const res = await fetch(`${token.instanceUrl}${path}`, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });

  if (res.status === 401 && retry) {
    cachedToken = null;
    return sfFetch(path, { retry: false });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce API error (${res.status}) on ${path}: ${text}`);
  }

  return res.json();
}

/**
 * Runs a report and returns its detail row count (matches the number shown
 * in the tile's grand-total, since these reports have no groupings).
 */
export async function getReportRowCount(reportId) {
  const data = await sfFetch(
    `/services/data/${SF_API_VERSION}/analytics/reports/${reportId}?includeDetails=true`
  );

  const grandTotal = data.factMap?.['T!T'];
  if (grandTotal?.rows) {
    console.log(`[salesforce] report ${reportId} fetched successfully (${grandTotal.rows.length} rows)`);
    return grandTotal.rows.length;
  }

  // Grouped report fallback: sum rows across every bucket.
  const count = Object.values(data.factMap || {}).reduce(
    (sum, group) => sum + (group.rows ? group.rows.length : 0),
    0
  );
  console.log(`[salesforce] report ${reportId} fetched successfully (${count} rows, grouped)`);
  return count;
}

let cachedBucketMap = null; // Map<Product_Type__c value, 'aa' | 'ae'>

/**
 * Mirrors the "Product Line" bucket field configured on the AA Tickets
 * report (the same one shown in Salesforce's bucket editor) so a Product
 * Type value counts toward the same service here as it does in the report
 * tiles. Cached for the process lifetime — bucket assignments change rarely
 * and restarting the server is enough to pick up an edit.
 */
async function getProductLineBucketMap() {
  if (cachedBucketMap) return cachedBucketMap;

  const reportId = process.env.SF_REPORT_AA;
  const data = await sfFetch(`/services/data/${SF_API_VERSION}/analytics/reports/${reportId}/describe`);
  const bucket = data.reportMetadata?.buckets?.find((b) => b.sourceColumnName === 'Case.Product_Type__c');

  const map = new Map();
  for (const { label, sourceDimensionValues } of bucket?.values || []) {
    const service = label === 'AA' ? 'aa' : label === 'AE' ? 'ae' : null;
    if (!service) continue;
    for (const value of sourceDimensionValues) map.set(value, service);
  }

  cachedBucketMap = map;
  return map;
}

/**
 * gStore is counted by its own report via a direct equality filter, not
 * the AA/AE bucket, so it takes priority over the bucket's own "AE"
 * grouping of the gStore product type.
 */
function classifyProductType(productType, bucketMap) {
  if (!productType) return null;
  if (productType === 'gStore') return 'gstore';
  return bucketMap.get(productType) || null;
}

async function resolveListViewId(devNameOrId) {
  const looksLikeId = /^00B[a-zA-Z0-9]{12,15}$/.test(devNameOrId);
  if (looksLikeId) return devNameOrId;

  const all = await sfFetch(`/services/data/${SF_API_VERSION}/sobjects/Case/listviews`);
  const match = all.listviews.find(
    (lv) => lv.developerName === devNameOrId || lv.label === devNameOrId
  );
  if (!match) throw new Error(`Case list view "${devNameOrId}" not found`);
  return match.id;
}

// The List View Results API always includes these system/audit fields even
// when the Salesforce UI hides them for this list view.
const HIDDEN_CASE_FIELDS = new Set([
  'Id',
  'RecordTypeId',
  'CreatedDate',
  'LastModifiedDate',
  'SystemModstamp',
  'Default_Ticket_IM__c',
]);

const SALESFORCE_ID = /^[a-zA-Z0-9]{15,18}$/;

// Salesforce labels this relationship field after the lookup ("Default Ticket IM"),
// not the case number it actually displays.
const COLUMN_LABEL_OVERRIDES = {
  'Default_Ticket_IM__r.CaseNumber': 'Case ID',
};

/**
 * Each IM Bridge row is a bridge case pointing at the actual incident via
 * Default_Ticket_IM__c; that incident's Product_Type__c is what determines
 * AA/AE/gStore, so it has to be looked up separately from the list view.
 */
async function getProductTypesByCaseId(caseIds) {
  const ids = [...new Set(caseIds)].filter((id) => SALESFORCE_ID.test(id));
  if (!ids.length) return new Map();

  const soql = `SELECT Id, Product_Type__c, End_Time_of_Incident__c FROM Case WHERE Id IN (${ids.map((id) => `'${id}'`).join(',')})`;
  const data = await sfFetch(`/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`);

  return new Map(data.records.map((r) => [r.Id, { productType: r.Product_Type__c, endTime: r.End_Time_of_Incident__c }]));
}

/**
 * Returns { columns, rows } for a Case list view, using the same columns
 * and filters configured on the list view in Salesforce, unfiltered. Adds
 * a synthetic leading "Service" column classifying each row as aa/ae/gstore
 * to match the AA/AE/gStore report tiles, when the list view links to the
 * underlying incident via Default_Ticket_IM__c.
 */
export async function getCaseListView(devNameOrId) {
  const listViewId = await resolveListViewId(devNameOrId);
  const results = await sfFetch(
    `/services/data/${SF_API_VERSION}/sobjects/Case/listviews/${listViewId}/results`
  );

  const columns = results.columns
    .filter((col) => !HIDDEN_CASE_FIELDS.has(col.fieldNameOrPath))
    .map((col) => ({
      field: col.fieldNameOrPath,
      label: COLUMN_LABEL_OVERRIDES[col.fieldNameOrPath] || col.label,
    }));

  const rows = results.records.map((record) =>
    Object.fromEntries(record.columns.map((col) => [col.fieldNameOrPath, col.value]))
  );

  const hasIncidentLink = results.columns.some((col) => col.fieldNameOrPath === 'Default_Ticket_IM__c');
  let activeRows = rows;
  if (hasIncidentLink) {
    const [productTypesById, bucketMap] = await Promise.all([
      getProductTypesByCaseId(rows.map((r) => r.Default_Ticket_IM__c)),
      getProductLineBucketMap(),
    ]);

    activeRows = rows.filter((row) => {
      const caseData = productTypesById.get(row.Default_Ticket_IM__c);
      return !caseData?.endTime;
    });

    activeRows.forEach((row) => {
      const productType = productTypesById.get(row.Default_Ticket_IM__c)?.productType;
      row.__service = classifyProductType(productType, bucketMap);
      row.__caseUrl = row.Default_Ticket_IM__c
        ? `${SF_INSTANCE_URL}/lightning/r/Case/${row.Default_Ticket_IM__c}/view`
        : null;
    });
    columns.unshift({ field: '__service', label: 'Service' });
  }

  const finalRows = hasIncidentLink ? activeRows : rows.filter((row) => !row.End_Time_of_Incident__c);
  console.log(`[salesforce] case list view "${devNameOrId}" fetched successfully (${finalRows.length} case(s))`);
  return { columns, rows: finalRows, size: finalRows.length };
}

// Fields pulled for the Software Stability page's TEO KPI computation,
// ported from app_v2.py's SF_CASE_FIELDS (L906-917).
const TEO_CASE_FIELDS = [
  'Id', 'CaseNumber', 'Subject', 'Type', 'Status', 'IsClosed', 'IsEscalated',
  'CreatedDate', 'ClosedDate',
  'Jira_Ticket_Id__c', 'Jira_Ticket_URL__c', 'Jira_Severity__c',
  'Jira_Project__c', 'GM_Team__c', 'GM_Origins__c', 'Product_Type__c',
  'Account_Name__c', 'First_Response_Time__c',
  'Category__c', 'SLA_Category__c',
];
const TEO_CASE_TYPES = ['Incident'];
const TEO_PRODUCT_TYPES = ['RTP', 'TTP'];
const TEO_CASE_CATEGORY = 'Software';

/**
 * Fetch SF cases created within [startDate, endDate] (YYYY-MM-DD, IST-aligned
 * bounds) for the TEO KPI pipeline in server/teoKpi.js. Defaults to the
 * documented scope (Incident, RTP/TTP) — mirrors app_v2.py's fetch_sf_cases —
 * but the Software Stability page's Ticket Category / Product Type filter
 * chips can override either list to widen or narrow it.
 */
export async function getTeoCases(startDate, endDate, { types = TEO_CASE_TYPES, products = TEO_PRODUCT_TYPES } = {}) {
  const fieldsClause = TEO_CASE_FIELDS.join(', ');
  const typesClause = types.map((t) => `'${t}'`).join(', ');
  const productsClause = products.map((p) => `'${p}'`).join(', ');
  const soql =
    `SELECT ${fieldsClause} FROM Case ` +
    `WHERE CreatedDate >= ${startDate}T00:00:00+05:30 ` +
    `AND CreatedDate <= ${endDate}T23:59:59+05:30 ` +
    `AND Type IN (${typesClause}) ` +
    `AND Product_Type__c IN (${productsClause}) ` +
    `AND Category__c = '${TEO_CASE_CATEGORY}'`;

  let records = [];
  let nextPath = `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  while (nextPath) {
    const result = await sfFetch(nextPath);
    records.push(...(result.records || []));
    nextPath = result.done ? null : (result.nextRecordsUrl || null);
  }

  console.log(`[salesforce] getTeoCases: ${records.length} case(s) from ${startDate} to ${endDate}`);
  return records;
}

export async function getTrendData(startDate, timeZone = 'UTC') {
  const bucketMap = await getProductLineBucketMap();

  // Fetch individual records (not a SOQL-side GROUP BY DAY_ONLY, which
  // buckets by the running/integration user's own Salesforce timezone) so
  // each case can be bucketed by calendar day in the *requested* timezone
  // instead — keeping the chart's day totals aligned with how each case's
  // time gets displayed elsewhere in the dashboard.
  const isoStart = startDate.toISOString().replace(/\.\d{3}/, "");
  const cutoffDay = dayKeyInZone(startDate, timeZone);

  const soql =
    "SELECT Product_Type__c, CreatedDate FROM Case " +
    "WHERE Type = 'Incident' " +
    "AND Highest_Severity__c IN ('Severity 1','Severity 2') " +
    "AND Impact_Percentage__c >= 50 " +
    "AND CreatedDate >= " + isoStart + " " +
    "ORDER BY CreatedDate ASC";

  let records = [];
  let nextPath = `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  while (nextPath) {
    const result = await sfFetch(nextPath);
    records.push(...(result.records || []));
    nextPath = result.done ? null : (result.nextRecordsUrl || null);
  }

  const dateMap = new Map();
  for (const rec of records) {
    const day = dayKeyInZone(new Date(rec.CreatedDate), timeZone);
    if (day < cutoffDay) continue;
    const svc = classifyProductType(rec.Product_Type__c, bucketMap);
    if (!dateMap.has(day)) dateMap.set(day, { aa: 0, ae: 0, gstore: 0 });
    if (svc) dateMap.get(day)[svc] += 1;
  }

  console.log(`[salesforce] getTrendData: ${records.length} case(s) from ${isoStart} (tz=${timeZone})`);
  return dateMap;
}

/**
 * Returns every case from the last `days` calendar days (in `timeZone`),
 * using the exact same filter as getTrendData (Incident, Sev 1 or 2,
 * Impact >= 50%) so the history list always reconciles with the trend
 * chart's totals. Newest first.
 */
export async function getTicketHistory(days, timeZone = 'UTC') {
  const bucketMap = await getProductLineBucketMap();
  const now = new Date();
  const startDay = dayKeyInZone(new Date(now.getTime() - days * 86400000), timeZone);
  const dayStart = zonedMidnightUtc(startDay, timeZone);

  const soql =
    "SELECT Id, CaseNumber, Subject, Highest_Severity__c, Product_Type__c, " +
    "Impact_Percentage__c, CreatedDate, End_Time_of_Incident__c, Account.Name " +
    "FROM Case " +
    "WHERE Type = 'Incident' " +
    "AND Highest_Severity__c IN ('Severity 1','Severity 2') " +
    "AND Impact_Percentage__c >= 50 " +
    "AND CreatedDate >= " + dayStart.toISOString().replace(/\.\d{3}/, "") + " " +
    "ORDER BY CreatedDate DESC";

  let records = [];
  let nextPath = `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  while (nextPath) {
    const result = await sfFetch(nextPath);
    records.push(...(result.records || []));
    nextPath = result.done ? null : (result.nextRecordsUrl || null);
  }

  const cases = records
    .map((r) => ({
      id: r.Id,
      caseNumber: r.CaseNumber,
      subject: r.Subject,
      severity: r.Highest_Severity__c,
      productType: r.Product_Type__c,
      impact: r.Impact_Percentage__c,
      accountName: r.Account?.Name || null,
      createdDate: r.CreatedDate,
      endTime: r.End_Time_of_Incident__c || null,
      resolutionMs: r.End_Time_of_Incident__c
        ? new Date(r.End_Time_of_Incident__c) - new Date(r.CreatedDate)
        : null,
      day: dayKeyInZone(new Date(r.CreatedDate), timeZone),
      service: classifyProductType(r.Product_Type__c, bucketMap),
      url: `${SF_INSTANCE_URL}/lightning/r/Case/${r.Id}/view`,
    }))
    .filter((c) => c.service);

  console.log(`[salesforce] getTicketHistory: ${cases.length} case(s) from ${startDay} (tz=${timeZone})`);
  return cases;
}

/**
 * Returns the individual cases behind one day's trend-chart totals, using
 * the exact same filter as getTrendData (Incident, Sev 1 or 2, Impact >= 50%)
 * so the drill-down list always reconciles with the number shown on the chart.
 * `dateStr`'s day boundaries are computed in `timeZone` so the cases returned
 * match the same calendar day getTrendData bucketed them into.
 */
export async function getTrendDayDetail(dateStr, timeZone = 'UTC') {
  const bucketMap = await getProductLineBucketMap();
  const dayStart = zonedMidnightUtc(dateStr, timeZone);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000 - 1000);

  const soql =
    "SELECT Id, CaseNumber, Subject, Highest_Severity__c, Product_Type__c, " +
    "Impact_Percentage__c, CreatedDate " +
    "FROM Case " +
    "WHERE Type = 'Incident' " +
    "AND Highest_Severity__c IN ('Severity 1','Severity 2') " +
    "AND Impact_Percentage__c >= 50 " +
    "AND CreatedDate >= " + dayStart.toISOString().replace(/\.\d{3}/, "") + " " +
    "AND CreatedDate <= " + dayEnd.toISOString().replace(/\.\d{3}/, "") + " " +
    "ORDER BY CreatedDate ASC";

  let records = [];
  let nextPath = `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  while (nextPath) {
    const result = await sfFetch(nextPath);
    records.push(...(result.records || []));
    nextPath = result.done ? null : (result.nextRecordsUrl || null);
  }

  const cases = records
    .map((r) => ({
      id: r.Id,
      caseNumber: r.CaseNumber,
      subject: r.Subject,
      severity: r.Highest_Severity__c,
      productType: r.Product_Type__c,
      impact: r.Impact_Percentage__c,
      createdDate: r.CreatedDate,
      service: classifyProductType(r.Product_Type__c, bucketMap),
      url: `${SF_INSTANCE_URL}/lightning/r/Case/${r.Id}/view`,
    }))
    .filter((c) => c.service);

  console.log(`[salesforce] getTrendDayDetail: ${cases.length} case(s) on ${dateStr}`);
  return cases;
}

// ---------------------------------------------------------------------------
// Ticket Inflow Health (Ticket Health page). Tickets are created in
// Salesforce first — the BigQuery-backed panel reads a Zendesk mirror of
// them, which lags — so this reads Case directly instead. There's no
// dedicated "Site" field on Case; Account_Name__c is used verbatim as the
// site name for both the site filter and the sitewise breakdown.
// ---------------------------------------------------------------------------

const TICKET_HEALTH_TREND_WEEKS = 13; // matches the BigQuery panels' trend window
const IST_OFFSET_MIN = 5 * 60 + 30;

// ISO-8601 week (Monday-Sunday) containing `dateStr` ("YYYY-MM-DD"), with its
// Monday/Sunday boundaries — computed independently of any external week
// catalog so this function has no BigQuery dependency.
function isoWeekOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - dayNum);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  // ISO week/year is defined by the week's Thursday (the year it falls in).
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 86400000));

  const fmt = (dt) => dt.toISOString().slice(0, 10);
  return { year: thursday.getUTCFullYear(), week, start: fmt(monday), end: fmt(sunday) };
}

// IST calendar day ("YYYY-MM-DD") a Salesforce CreatedDate (UTC ISO string)
// falls on — Case creation is treated as IST throughout this dashboard's
// SF-backed panels (see getTeoCases' +05:30 query bounds).
function istDayKey(createdDate) {
  const ist = new Date(new Date(createdDate).getTime() + IST_OFFSET_MIN * 60000);
  return ist.toISOString().slice(0, 10);
}

function wowPctChange(current, previous) {
  if (previous > 0) return ((current - previous) / previous) * 100;
  return current > 0 ? null : 0; // null => "new" (nothing to compare against)
}

// SOQL has no bind-parameter API for GET-based queries, so string values
// (site names in particular — free text off Account_Name__c) get their
// quotes escaped rather than trusted verbatim.
function soqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Ticket Inflow Health data for the Ticket Health page's Ticket Inflow
 * panel, read straight from Salesforce Case — the system these tickets are
 * actually created in — instead of the BigQuery Zendesk mirror the rest of
 * that page uses. In scope: Type = 'Incident' AND Category__c = 'Software',
 * further narrowed by site (Account_Name__c), Product_Type__c, and
 * SLA_Category__c (this panel's own Severity 1-4 tabs) when supplied.
 *
 * `anchor` (YYYY-MM-DD, defaults to today) selects which ISO week is
 * "this week"; the trend covers the `weeks` ISO weeks up to and including it,
 * and the sitewise breakdown compares that week against the one before it —
 * mirroring getTicketInflowData's shape (trend/sitewise/headline/selectedWeek)
 * in bigquery.js so either can back the same panel.
 */
export async function getTicketInflowHealth({
  anchor = new Date().toISOString().slice(0, 10),
  weeks = TICKET_HEALTH_TREND_WEEKS,
  sites = [],
  products = [],
  severities = [],
} = {}) {
  const anchorWeek = isoWeekOf(anchor);
  const rangeStartDate = new Date(`${anchorWeek.start}T00:00:00Z`);
  rangeStartDate.setUTCDate(rangeStartDate.getUTCDate() - (weeks - 1) * 7);
  const rangeStart = rangeStartDate.toISOString().slice(0, 10);

  const clauses = [`Type = 'Incident'`, `Category__c = 'Software'`];
  if (sites.length) clauses.push(`Account_Name__c IN (${sites.map(soqlString).join(',')})`);
  if (products.length) clauses.push(`Product_Type__c IN (${products.map(soqlString).join(',')})`);
  if (severities.length) clauses.push(`SLA_Category__c IN (${severities.map(soqlString).join(',')})`);
  clauses.push(`CreatedDate >= ${rangeStart}T00:00:00+05:30`);
  clauses.push(`CreatedDate <= ${anchorWeek.end}T23:59:59+05:30`);

  const soql = `SELECT CreatedDate, Account_Name__c FROM Case WHERE ${clauses.join(' AND ')}`;

  let records = [];
  let nextPath = `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  while (nextPath) {
    const result = await sfFetch(nextPath);
    records.push(...(result.records || []));
    nextPath = result.done ? null : (result.nextRecordsUrl || null);
  }

  // The ordered list of ISO weeks in the trend window, oldest first.
  const weekList = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const d = new Date(`${anchorWeek.start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i * 7);
    weekList.push(isoWeekOf(d.toISOString().slice(0, 10)));
  }
  const weekKey = (w) => `${w.year}-${w.week}`;
  const countByWeek = new Map(weekList.map((w) => [weekKey(w), 0]));
  const prevWeek = weekList.length >= 2 ? weekList[weekList.length - 2] : null;

  const bySiteThisWeek = new Map();
  const bySitePrevWeek = new Map();

  for (const rec of records) {
    const wk = isoWeekOf(istDayKey(rec.CreatedDate));
    const key = weekKey(wk);
    if (countByWeek.has(key)) countByWeek.set(key, countByWeek.get(key) + 1);

    const site = rec.Account_Name__c;
    if (!site) continue;
    if (key === weekKey(anchorWeek)) {
      bySiteThisWeek.set(site, (bySiteThisWeek.get(site) || 0) + 1);
    } else if (prevWeek && key === weekKey(prevWeek)) {
      bySitePrevWeek.set(site, (bySitePrevWeek.get(site) || 0) + 1);
    }
  }

  const trend = weekList.map((w) => ({ year: w.year, week: w.week, count: countByWeek.get(weekKey(w)) }));
  const sitewise = [...bySiteThisWeek.entries()]
    .map(([name, count]) => ({ name, count, pctChange: wowPctChange(count, bySitePrevWeek.get(name) || 0) }))
    .sort((a, b) => b.count - a.count);

  const totalCount = trend.length ? trend[trend.length - 1].count : 0;
  const prevTotal = trend.length >= 2 ? trend[trend.length - 2].count : 0;
  const prior4 = trend.slice(-5, -1);
  const prevMa = prior4.length ? prior4.reduce((sum, w) => sum + w.count, 0) / prior4.length : 0;

  console.log(`[salesforce] getTicketInflowHealth: ${records.length} case(s), week ${anchorWeek.year}-W${anchorWeek.week}`);

  return {
    trend,
    sitewise,
    headline: { count: totalCount, wowPct: wowPctChange(totalCount, prevTotal), prevMa },
    selectedWeek: { year: anchorWeek.year, week: anchorWeek.week, start: anchorWeek.start, end: anchorWeek.end },
  };
}

// ---------------------------------------------------------------------------
// Ticket Backlog Health (Ticket Health page) — same Salesforce-first
// rationale as getTicketInflowHealth above. Unlike the BigQuery Zendesk
// mirror, whose Ticket_Solved_IST has an ETL gap on ~13% of solved cases
// (see bigquery.js's EFFECTIVE_SOLVED_AT fallback), Case.IsClosed/ClosedDate
// are live fields with no such gap, so no fallback timestamp is needed here.
// ---------------------------------------------------------------------------

// Fixed to Severity 1-3 for the SLA/Aging tiles only, mirroring the
// BigQuery panel's SLA_AGING_SEVERITIES — the trend/status/sitewise
// sections below span every severity, same as there.
const BACKLOG_SLA_AGING_SEVERITIES = new Set(['Severity 1', 'Severity 2', 'Severity 3']);

function istTimestampMs(dateStr, endOfDay = false) {
  return Date.parse(`${dateStr}T${endOfDay ? '23:59:59.999' : '00:00:00'}+05:30`);
}

// Within-SLA rule for a closed Sev1-3 case, ported from Support Performance
// KPI.xlsx (Solved_Ticket sheet) via bigquery.js's getTicketBacklogData:
//   Sev1: resolved <= 60 min
//   Sev2: resolved <= 60 min if >=50% systems affected, else <= 120 min
//   Sev3: resolved <= 1440 min (24h)
// Impact_Percentage__c stands in for "% systems affected" — the same field
// getTrendData/getTicketHistory already use for that concept.
function withinBacklogSla(severity, resolutionMin, impactPct) {
  if (severity === 'Severity 1') return resolutionMin <= 60;
  if (severity === 'Severity 2') return impactPct >= 50 ? resolutionMin <= 60 : resolutionMin <= 120;
  if (severity === 'Severity 3') return resolutionMin <= 1440;
  return false;
}

/**
 * Ticket Backlog Health data for the Ticket Health page's Ticket Backlog
 * panel, read from Salesforce Case instead of the BigQuery Zendesk mirror.
 * Same base scope as getTicketInflowHealth (Type = 'Incident' AND
 * Category__c = 'Software'), narrowed by site (Account_Name__c) and
 * Product_Type__c — no Severity-tab equivalent here: the SLA/Aging tiles
 * are hardcoded to Severity 1-3 regardless of filters, while the trend,
 * Status donut, and sitewise aging breakdown span every severity, matching
 * bigquery.js's shape.
 *
 * `anchor`/`weeks` behave like getTicketInflowHealth's: `anchor` selects
 * "this week" for the trend/SLA window, while Status/Aging/Sitewise-aging
 * always reflect *now* (Case's live IsClosed/Status), not the selected week.
 */
export async function getTicketBacklogHealth({
  anchor = new Date().toISOString().slice(0, 10),
  weeks = TICKET_HEALTH_TREND_WEEKS,
  sites = [],
  products = [],
} = {}) {
  const anchorWeek = isoWeekOf(anchor);
  const rangeStartDate = new Date(`${anchorWeek.start}T00:00:00Z`);
  rangeStartDate.setUTCDate(rangeStartDate.getUTCDate() - (weeks - 1) * 7);
  const rangeStartTs = `${rangeStartDate.toISOString().slice(0, 10)}T00:00:00+05:30`;

  const clauses = [`Type = 'Incident'`, `Category__c = 'Software'`];
  if (sites.length) clauses.push(`Account_Name__c IN (${sites.map(soqlString).join(',')})`);
  if (products.length) clauses.push(`Product_Type__c IN (${products.map(soqlString).join(',')})`);
  // Only cases that could still be "open" somewhere in the trend window —
  // still open now, or closed after the window's earliest week started.
  // (A currently-open case with no ClosedDate always passes.)
  clauses.push(`(IsClosed = false OR ClosedDate > ${rangeStartTs})`);

  const soql =
    `SELECT CreatedDate, ClosedDate, IsClosed, Status, SLA_Category__c, ` +
    `Impact_Percentage__c, Account_Name__c FROM Case WHERE ${clauses.join(' AND ')}`;

  let records = [];
  let nextPath = `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  while (nextPath) {
    const result = await sfFetch(nextPath);
    records.push(...(result.records || []));
    nextPath = result.done ? null : (result.nextRecordsUrl || null);
  }

  const parsed = records.map((r) => ({
    createdMs: Date.parse(r.CreatedDate),
    closedMs: r.ClosedDate ? Date.parse(r.ClosedDate) : null,
    isClosed: Boolean(r.IsClosed),
    status: r.Status || 'Unknown',
    severity: r.SLA_Category__c,
    impact: typeof r.Impact_Percentage__c === 'number' ? r.Impact_Percentage__c : null,
    site: r.Account_Name__c,
  }));

  const openAsOf = (rec, ts) => rec.createdMs <= ts && (rec.closedMs === null || rec.closedMs > ts);

  // Trend: point-in-time open count as of each of the last `weeks` ISO weeks.
  const weekList = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const d = new Date(`${anchorWeek.start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i * 7);
    weekList.push(isoWeekOf(d.toISOString().slice(0, 10)));
  }
  const trend = weekList.map((w) => {
    const endTs = istTimestampMs(w.end, true);
    return { year: w.year, week: w.week, count: parsed.filter((r) => openAsOf(r, endTs)).length };
  });

  const overallCount = trend.length ? trend[trend.length - 1].count : 0;
  const prevOverall = trend.length >= 2 ? trend[trend.length - 2].count : 0;

  // SLA Achieved % (Sev 1-3): of cases closed within the anchor week.
  const weekStartTs = istTimestampMs(anchorWeek.start, false);
  const weekEndTs = istTimestampMs(anchorWeek.end, true);
  let slaWithin = 0;
  let slaTotal = 0;
  for (const r of parsed) {
    if (!BACKLOG_SLA_AGING_SEVERITIES.has(r.severity)) continue;
    if (r.closedMs === null || r.closedMs < weekStartTs || r.closedMs > weekEndTs) continue;
    slaTotal += 1;
    const resolutionMin = (r.closedMs - r.createdMs) / 60000;
    if (withinBacklogSla(r.severity, resolutionMin, r.impact)) slaWithin += 1;
  }

  // Aging (Sev 1-3) + Status + Sitewise BL aging all read the case's
  // *current* IsClosed/Status (fetched live) rather than the selected week.
  const openNow = parsed.filter((r) => !r.isClosed);
  const nowMs = Date.now();

  const openSev123 = openNow.filter((r) => BACKLOG_SLA_AGING_SEVERITIES.has(r.severity));
  const agingDays = openSev123.length
    ? openSev123.reduce((sum, r) => sum + (nowMs - r.createdMs), 0) / openSev123.length / 86400000
    : null;

  const statusCounts = new Map();
  for (const r of openNow) statusCounts.set(r.status, (statusCounts.get(r.status) || 0) + 1);
  const status = [...statusCounts.entries()]
    .map(([s, count]) => ({ status: s, count }))
    .sort((a, b) => b.count - a.count);

  const siteAgg = new Map(); // site -> { count, totalAgeMs }
  for (const r of openNow) {
    if (!r.site) continue;
    if (!siteAgg.has(r.site)) siteAgg.set(r.site, { count: 0, totalAgeMs: 0 });
    const agg = siteAgg.get(r.site);
    agg.count += 1;
    agg.totalAgeMs += nowMs - r.createdMs;
  }
  const sitewise = [...siteAgg.entries()]
    .map(([name, agg]) => ({ name, count: agg.count, agingDays: agg.totalAgeMs / agg.count / 86400000 }))
    .sort((a, b) => b.count - a.count);

  console.log(`[salesforce] getTicketBacklogHealth: ${records.length} case(s), week ${anchorWeek.year}-W${anchorWeek.week}`);

  return {
    trend,
    sitewise,
    status,
    headline: { count: overallCount, wowPct: wowPctChange(overallCount, prevOverall) },
    sla: { pct: slaTotal > 0 ? (slaWithin / slaTotal) * 100 : null, within: slaWithin, total: slaTotal },
    agingDays,
    selectedWeek: { year: anchorWeek.year, week: anchorWeek.week, start: anchorWeek.start, end: anchorWeek.end },
  };
}

// ---------------------------------------------------------------------------
// Ticket Resolution Health (Ticket Health page) — how many "critical" tickets
// (Highest_Severity__c Sev 1/2 with Impact_Percentage__c >= 50%, the same
// scope as the home page's Critical Trend panel — see getTrendData) get
// solved each week, and how long that takes. Only closed cases are queried,
// so unlike getTicketBacklogHealth there's no EFFECTIVE_SOLVED_AT-style
// fallback needed — ClosedDate is always populated once IsClosed is true.
// ---------------------------------------------------------------------------

const RESOLUTION_SEVERITIES = ['Severity 1', 'Severity 2'];

// Both Sev1 and Sev2 collapse to the same 60-minute bar here: every ticket in
// this scope already clears the >=50% impact threshold that pushes Sev2's own
// threshold down to 60 min in withinBacklogSla.
function withinResolutionSla(resolutionMin) {
  return resolutionMin <= 60;
}

/**
 * `anchor`/`weeks` behave like the other Ticket Health panels': `anchor`
 * selects "this week" for the Solved Tickets headline, SLA Adherence %, and
 * MTTR (Hours) tiles. MTTR by SLA Category and the sitewise Resolution
 * Analysis both aggregate across the full `weeks`-week trend window instead —
 * a single week's critical-ticket volume is often just a handful of cases
 * (see the Solved Tickets trend), too thin a sample to break down further.
 */
export async function getTicketResolutionHealth({
  anchor = new Date().toISOString().slice(0, 10),
  weeks = TICKET_HEALTH_TREND_WEEKS,
  sites = [],
  products = [],
} = {}) {
  const anchorWeek = isoWeekOf(anchor);
  const rangeStartDate = new Date(`${anchorWeek.start}T00:00:00Z`);
  rangeStartDate.setUTCDate(rangeStartDate.getUTCDate() - (weeks - 1) * 7);
  const rangeStartTs = `${rangeStartDate.toISOString().slice(0, 10)}T00:00:00+05:30`;
  const rangeEndTs = `${anchorWeek.end}T23:59:59+05:30`;

  const clauses = [
    `Type = 'Incident'`, `Category__c = 'Software'`,
    `Highest_Severity__c IN ('Severity 1','Severity 2')`,
    `Impact_Percentage__c >= 50`,
    `IsClosed = true`,
    `ClosedDate >= ${rangeStartTs}`,
    `ClosedDate <= ${rangeEndTs}`,
  ];
  if (sites.length) clauses.push(`Account_Name__c IN (${sites.map(soqlString).join(',')})`);
  if (products.length) clauses.push(`Product_Type__c IN (${products.map(soqlString).join(',')})`);

  const soql =
    `SELECT CreatedDate, ClosedDate, Highest_Severity__c, Account_Name__c FROM Case WHERE ${clauses.join(' AND ')}`;

  let records = [];
  let nextPath = `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  while (nextPath) {
    const result = await sfFetch(nextPath);
    records.push(...(result.records || []));
    nextPath = result.done ? null : (result.nextRecordsUrl || null);
  }

  const parsed = records
    .map((r) => ({
      createdMs: Date.parse(r.CreatedDate),
      closedMs: Date.parse(r.ClosedDate),
      severity: r.Highest_Severity__c,
      site: r.Account_Name__c,
    }))
    .filter((r) => Number.isFinite(r.createdMs) && Number.isFinite(r.closedMs));

  const weekList = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const d = new Date(`${anchorWeek.start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i * 7);
    weekList.push(isoWeekOf(d.toISOString().slice(0, 10)));
  }
  const weekKey = (w) => `${w.year}-${w.week}`;
  const countByWeek = new Map(weekList.map((w) => [weekKey(w), 0]));

  for (const r of parsed) {
    const key = weekKey(isoWeekOf(istDayKey(r.closedMs)));
    if (countByWeek.has(key)) countByWeek.set(key, countByWeek.get(key) + 1);
  }

  const trend = weekList.map((w) => ({ year: w.year, week: w.week, count: countByWeek.get(weekKey(w)) }));
  const totalCount = trend.length ? trend[trend.length - 1].count : 0;
  const prevTotal = trend.length >= 2 ? trend[trend.length - 2].count : 0;
  const prior4 = trend.slice(-5, -1);
  const prevMa = prior4.length ? prior4.reduce((sum, w) => sum + w.count, 0) / prior4.length : 0;

  // "This week" slice for the SLA Adherence % / MTTR (Hours) tiles.
  const thisWeekKey = weekKey(anchorWeek);
  const thisWeekRecords = parsed.filter((r) => weekKey(isoWeekOf(istDayKey(r.closedMs))) === thisWeekKey);
  const hoursOf = (r) => (r.closedMs - r.createdMs) / 3600000;

  const mttrHours = thisWeekRecords.length
    ? thisWeekRecords.reduce((sum, r) => sum + hoursOf(r), 0) / thisWeekRecords.length
    : null;

  const slaWithin = thisWeekRecords.filter((r) => withinResolutionSla(hoursOf(r) * 60)).length;
  const slaPct = thisWeekRecords.length ? (slaWithin / thisWeekRecords.length) * 100 : null;

  // MTTR by SLA Category and the sitewise breakdown both aggregate across the
  // full trend window rather than just the anchor week — see doc comment.
  const bySeverity = new Map();
  for (const r of parsed) {
    if (!bySeverity.has(r.severity)) bySeverity.set(r.severity, { count: 0, totalHours: 0 });
    const agg = bySeverity.get(r.severity);
    agg.count += 1;
    agg.totalHours += hoursOf(r);
  }
  const mttrByCategory = RESOLUTION_SEVERITIES
    .filter((sev) => bySeverity.has(sev))
    .map((sev) => {
      const agg = bySeverity.get(sev);
      return { severity: sev, count: agg.count, hours: agg.totalHours / agg.count };
    });

  const siteAgg = new Map();
  for (const r of parsed) {
    if (!r.site) continue;
    if (!siteAgg.has(r.site)) siteAgg.set(r.site, { count: 0, totalHours: 0 });
    const agg = siteAgg.get(r.site);
    agg.count += 1;
    agg.totalHours += hoursOf(r);
  }
  const sitewise = [...siteAgg.entries()]
    .map(([name, agg]) => ({ name, count: agg.count, hours: agg.totalHours / agg.count }))
    .sort((a, b) => b.count - a.count);

  console.log(`[salesforce] getTicketResolutionHealth: ${records.length} case(s), week ${anchorWeek.year}-W${anchorWeek.week}`);

  return {
    trend,
    headline: { count: totalCount, wowPct: wowPctChange(totalCount, prevTotal), prevMa },
    sla: { pct: slaPct, within: slaWithin, total: thisWeekRecords.length },
    mttrHours,
    mttrByCategory,
    sitewise,
    selectedWeek: { year: anchorWeek.year, week: anchorWeek.week, start: anchorWeek.start, end: anchorWeek.end },
  };
}
