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
