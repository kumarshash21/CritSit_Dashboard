// Jira REST v3 client + EA-ticket fetch helpers, ported from app_v2.py
// (the TEO KPI Streamlit prototype). Business-config constants below mirror
// that file's module-level constants verbatim.

const { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;

for (const [key, value] of Object.entries({ JIRA_EMAIL, JIRA_API_TOKEN })) {
  if (!value) throw new Error(`Missing required env var: ${key}`);
}

export const JIRA_URL = 'https://greyorange-work.atlassian.net';
export const GM_PROJECT = 'GM';
export const EA_ISSUE_TYPE = 'Engineering Analysis';
export const BUG_ISSUE_TYPE = 'Bug';

// EA tickets carrying either of these labels are hardware, not software —
// TEO KPIs exclude them. There's no positive "software" label, so we filter
// by exclusion (see app_v2.py L101-105).
export const EA_EXCLUDED_LABELS = ['HW_Support', 'TTP_HW_SUPPORT'];

const STAGE_WORKSPACE_ID = 'fc5b8d6f-f02e-4202-806d-1d41c9779519';

// TEO filter — two Jira account IDs whose EA resolutions don't count as QA
// throughput (app_v2.py L253-260).
const TEO_RESOLVED_BY_USERS_JQL =
  '5d9f265545fad00dc1264c72, 712020:0a1d470a-f897-4b00-8100-5efd5ce64d95';
const TEO_STAGE_ARI = `ari:cloud:cmdb::object/${STAGE_WORKSPACE_ID}/9826`;
const TEO_FILTER_STATUSES_JQL = '"Done", "Unable to Conclude", "No longer an issue"';

const EA_FIELDS =
  'summary,status,resolution,labels,issuelinks,created,resolutiondate,customfield_10121,customfield_10620';

function eaLabelClause() {
  if (!EA_EXCLUDED_LABELS.length) return '';
  const quoted = EA_EXCLUDED_LABELS.map((l) => `"${l}"`).join(', ');
  return `AND (labels is EMPTY OR labels not in (${quoted})) `;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jiraGet(path, params) {
  const url = new URL(`${JIRA_URL}/rest/api/3/${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Jira API error (${res.status}) on ${path}: ${text}`);
      }
      return res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(2 ** attempt * 1000); // 1s, 2s, 4s
    }
  }
  return undefined; // unreachable
}

/** Fetch every page for a JQL query. Mirrors app_v2.py's _jql_paginate. */
async function jqlPaginate(jql, fields) {
  const tickets = [];
  let nextPageToken;
  const pageSize = 50;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = { jql, maxResults: pageSize, fields, expand: 'changelog' };
    if (nextPageToken) params.nextPageToken = nextPageToken;
    const data = await jiraGet('search/jql', params);
    const issues = data.issues || [];
    tickets.push(...issues);
    nextPageToken = data.nextPageToken;
    if (!nextPageToken || issues.length < pageSize) break;
  }
  return tickets;
}

/**
 * Find the Stage ARI used by EA tickets created in [start, end] — the
 * team's period marker, more accurate than filtering on created date alone.
 */
export async function discoverStageAri(start, end) {
  const jql =
    `project = "${GM_PROJECT}" AND issuetype = "${EA_ISSUE_TYPE}" ` +
    `${eaLabelClause()}` +
    `AND created >= "${start}" AND created <= "${end}" ` +
    `AND "Stage" is not EMPTY ORDER BY created DESC`;

  const data = await jiraGet('search/jql', { jql, maxResults: 20, fields: 'customfield_10121' });
  const counts = new Map();
  for (const issue of data.issues || []) {
    const stages = issue.fields?.customfield_10121 || [];
    for (const s of stages) {
      const objId = s.objectId || (s.id ? s.id.split(':').pop() : null);
      if (objId) {
        const ari = `ari:cloud:cmdb::object/${STAGE_WORKSPACE_ID}/${objId}`;
        counts.set(ari, (counts.get(ari) || 0) + 1);
      }
    }
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** EA tickets for a Stage ARI, bounded to the period's created-date range. */
export async function fetchEaTicketsByStage(stageAri, start, end) {
  const jql =
    `project = "${GM_PROJECT}" AND issuetype = "${EA_ISSUE_TYPE}" ` +
    `${eaLabelClause()}` +
    `AND (cf[10689] = "Production" OR cf[10121] = "${stageAri}") ` +
    `AND created >= "${start}" AND created <= "${end}" ORDER BY created ASC`;
  return jqlPaginate(jql, EA_FIELDS);
}

/** Fallback EA fetch by created date when no Stage is detected. */
export async function fetchEaTicketsByDate(start, end) {
  const jql =
    `project = "${GM_PROJECT}" AND issuetype = "${EA_ISSUE_TYPE}" ` +
    `${eaLabelClause()}` +
    `AND created >= "${start}" AND created <= "${end}" ORDER BY created ASC`;
  return jqlPaginate(jql, EA_FIELDS);
}

/** GM keys matching the TEO filter for a given period start date. */
export async function fetchTeoFilterKeys(start) {
  const jql =
    `project = "${GM_PROJECT}" ` +
    `AND issuetype = "${EA_ISSUE_TYPE}" ` +
    `AND "Resolved By[User Picker (single user)]" in (${TEO_RESOLVED_BY_USERS_JQL}) ` +
    `AND createdDate >= "${start}" ` +
    `AND (cf[10689] = "Production" OR cf[10121] = "${TEO_STAGE_ARI}") ` +
    `AND status in (${TEO_FILTER_STATUSES_JQL})`;
  const issues = await jqlPaginate(jql, 'summary');
  return new Set(issues.map((i) => i.key).filter(Boolean));
}

/**
 * Fetch arbitrary GM issues by key, chunked in batches of 100 to stay
 * inside Jira's IN-clause limits.
 */
export async function fetchGmTicketsByKeys(keys) {
  const keyList = [...keys];
  if (!keyList.length) return [];
  const out = [];
  for (let i = 0; i < keyList.length; i += 100) {
    const batch = keyList.slice(i, i + 100);
    const inClause = batch.map((k) => `"${k}"`).join(',');
    const jql = `key in (${inClause})`;
    out.push(...(await jqlPaginate(jql, `${EA_FIELDS},issuetype`)));
  }
  return out;
}
