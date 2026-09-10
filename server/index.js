import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  getCaseListView, getTicketHistory, getTrendData, getTrendDayDetail,
  getTicketInflowHealth, getTicketBacklogHealth,
  getTicketResolutionHealth,
} from './salesforce.js';
import { dayKeyInZone, isValidTimeZone, zonedMidnightUtc } from './tz.js';
import { computeTeoKpis, currentIstYearMonth } from './teoKpi.js';
import { getPodMap, buildPodLookup, accountPod } from './podMap.js';
import {
  getUptimeData, getMtbfData, getStabilityFilterOptions, getAllSites,
  getWeekDateRange,
} from './bigquery.js';

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Maps the Software Stability page's Product Type filter chips to each
// backend's real value for that product — Salesforce's Product_Type__c
// picklist label and BigQuery uptime_main's Product code, which don't
// always agree (e.g. Case Pick is "Case Pick" in SF but "CP" in BigQuery).
const PRODUCT_TYPE_MAP = {
  'case-pick': { sf: 'Case Pick', bq: 'CP' },
  ra: { sf: 'RA', bq: 'RA' },
  relay: { sf: 'Relay', bq: 'Relay' },
  ril: { sf: 'RIL', bq: 'RIL' },
  rms: { sf: 'RMS', bq: 'RMS' },
  rtp: { sf: 'RTP', bq: 'RTP' },
  shuttle: { sf: 'Shuttle', bq: 'Shuttle' },
  ttp: { sf: 'TTP', bq: 'TTP' },
};

// Maps the Ticket Category chips to Salesforce's Case.Type picklist values.
// BigQuery's uptime_main has no ticket-category dimension, so this only
// ever feeds the Salesforce-backed /api/software-stability route.
const CATEGORY_TYPE_MAP = {
  incident: 'Incident',
  query: 'Query',
  'service-request': 'Service Request',
};

function mapValues(slugs, map, key) {
  return slugs.map((s) => (key ? map[s]?.[key] : map[s])).filter(Boolean);
}

function resolveTimeZone(tz) {
  return isValidTimeZone(tz) ? tz : 'UTC';
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4001;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/dashboard', async (req, res) => {
  try {
    const cases = await getCaseListView(process.env.SF_CASE_LISTVIEW);
    res.json({
      asOf: new Date().toISOString(),
      reportUrls: {
        aa: `${process.env.SF_INSTANCE_URL}/${process.env.SF_REPORT_AA}`,
        ae: `${process.env.SF_INSTANCE_URL}/${process.env.SF_REPORT_AE}`,
        gstore: `${process.env.SF_INSTANCE_URL}/${process.env.SF_REPORT_GSTORE}`,
      },
      cases,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/trend', async (req, res) => {
  try {
    const range = req.query.range || '7d';
    const timeZone = resolveTimeZone(req.query.tz);
    const now = new Date();
    let startDate;
    if (range === '2d') startDate = new Date(now - 2 * 86400000);
    else if (range === '7d') startDate = new Date(now - 7 * 86400000);
    else if (range === '1m') startDate = new Date(now - 30 * 86400000);
    else startDate = new Date(now - 180 * 86400000);

    const dateMap = await getTrendData(startDate, timeZone);

    // Walk calendar days in `timeZone` (not UTC) so the x-axis lines up
    // with the same days getTrendData bucketed the counts into.
    const days = [];
    let cursor = zonedMidnightUtc(dayKeyInZone(startDate, timeZone), timeZone);
    const endCursor = zonedMidnightUtc(dayKeyInZone(now, timeZone), timeZone);
    while (cursor.getTime() <= endCursor.getTime()) {
      const key = dayKeyInZone(cursor, timeZone);
      const entry = dateMap.get(key) || { aa: 0, ae: 0, gstore: 0 };
      days.push({ date: key, ...entry });
      cursor = new Date(cursor.getTime() + 24 * 3600 * 1000);
    }

    res.json({ trend: days });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/trend/detail', async (req, res) => {
  try {
    const date = req.query.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    const timeZone = resolveTimeZone(req.query.tz);
    const cases = await getTrendDayDetail(date, timeZone);
    res.json({ date, cases });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/trend/history', async (req, res) => {
  try {
    const days = Number(req.query.days) || 7;
    const timeZone = resolveTimeZone(req.query.tz);
    const cases = await getTicketHistory(days, timeZone);
    res.json({ days, cases });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/pods', async (req, res) => {
  try {
    const podMap = await getPodMap();
    res.json({ pods: Object.keys(podMap).sort() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/software-stability', async (req, res) => {
  try {
    const { year: defaultYear, month: defaultMonth } = currentIstYearMonth();
    const year = Number(req.query.year) || defaultYear;
    const month = Number(req.query.month) || defaultMonth;
    // week (matching the page's "Select Week" filter) takes priority over
    // month when present — see computeTeoKpis in teoKpi.js.
    const week = req.query.week ? Number(req.query.week) : undefined;
    if (week !== undefined && (!Number.isInteger(week) || week < 1 || week > 53)) {
      return res.status(400).json({ error: 'week must be an integer 1-53' });
    }
    if (week === undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
      return res.status(400).json({ error: 'month must be an integer 1-12' });
    }
    if (!Number.isInteger(year) || year < 2024) {
      return res.status(400).json({ error: 'year must be an integer >= 2024' });
    }
    const severities = toArray(req.query.severity);
    const pods = toArray(req.query.pod);
    const categorySlugs = toArray(req.query.category);
    const productSlugs = toArray(req.query.product);
    // Undefined (vs. an empty array) is what tells computeTeoKpis/getTeoCases
    // to fall back to the documented default scope — see PRODUCT_TYPE_MAP.
    const types = categorySlugs.length ? mapValues(categorySlugs, CATEGORY_TYPE_MAP) : undefined;
    const products = productSlugs.length ? mapValues(productSlugs, PRODUCT_TYPE_MAP, 'sf') : undefined;
    const site = typeof req.query.site === 'string' ? req.query.site : '';
    const data = await computeTeoKpis({ month, year, week, severities, pods, types, products, site });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// Resolves the Software Stability page's POD chips (built from the Pod-list
// spreadsheet, keyed by account/site name — see podMap.js) to the matching
// BigQuery uptime_main Site names, via the same fuzzy account/site matcher
// used for the SF-backed KPIs. A pod selection matching zero real sites
// (including the "every POD deselected" sentinel) falls back to a value no
// real Site can equal, so the query filters to nothing rather than everyone.
async function resolvePodSites(pods) {
  const [podMap, allSites] = await Promise.all([getPodMap(), getAllSites()]);
  const podLookup = buildPodLookup(podMap);
  const podSet = new Set(pods);
  const matched = allSites.filter((site) => {
    const pod = accountPod(site, podLookup);
    return pod && podSet.has(pod);
  });
  return matched.length ? matched : ['__no_site_match__'];
}

async function uptimeMtbfParams(req) {
  const year = req.query.year ? Number(req.query.year) : undefined;
  const week = req.query.week ? Number(req.query.week) : undefined;
  const explicitSites = toArray(req.query.site);
  const pods = toArray(req.query.pod);
  const products = mapValues(toArray(req.query.product), PRODUCT_TYPE_MAP, 'bq');

  let sites = explicitSites;
  if (pods.length) {
    const podSites = await resolvePodSites(pods);
    sites = explicitSites.length
      ? explicitSites.filter((s) => podSites.includes(s))
      : podSites;
    if (!sites.length) sites = ['__no_site_match__'];
  }
  return { year, week, sites, products };
}

// Ticket Inflow/Backlog Health read from zendesk_recent_standard_v1, whose
// Product_Type values are the plain label ('RTP', 'Case Pick', ...) rather
// than uptime_main's BigQuery code — so these routes map through
// PRODUCT_TYPE_MAP's 'sf' field (same strings Salesforce uses) instead of
// 'bq'. Site/POD resolution is unchanged: Standard_Site_Name shares
// uptime_main's Site vocabulary.
async function ticketParams(req) {
  const year = req.query.year ? Number(req.query.year) : undefined;
  const week = req.query.week ? Number(req.query.week) : undefined;
  const explicitSites = toArray(req.query.site);
  const pods = toArray(req.query.pod);
  const products = mapValues(toArray(req.query.product), PRODUCT_TYPE_MAP, 'sf');

  let sites = explicitSites;
  if (pods.length) {
    const podSites = await resolvePodSites(pods);
    sites = explicitSites.length
      ? explicitSites.filter((s) => podSites.includes(s))
      : podSites;
    if (!sites.length) sites = ['__no_site_match__'];
  }
  return { year, week, sites, products };
}

// Maps the Ticket Inflow Health panel's own Severity-tab chips (data-value
// "1".."4") to zendesk's SLA_Category values — independent of the page's
// main Severity filter chips, which only feed the SF/Jira-backed KPI cards.
function severityLabels(slugs) {
  return slugs.filter((s) => /^[1-4]$/.test(s)).map((s) => `Severity ${s}`);
}

// Resolves the "Select Week" filter's (year, week) pair — numbered against
// BigQuery's uptime_main week catalog, the only week catalog this page's
// dropdown has — to a concrete anchor date for the Salesforce-backed Ticket
// Inflow/Backlog Health functions' own ISO-week trends. Only the boundary
// *dates* come from BigQuery here; the ticket data itself is all Salesforce.
// No selection defaults to the latest fully-completed ISO week (today - 7d),
// so an in-progress current week never reads as a misleading drop.
async function ticketHealthAnchor(year, week) {
  if (year && week) {
    const range = await getWeekDateRange({ year, week });
    if (range) return range.end;
  }
  return new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
}

app.get('/api/ticket-inflow', async (req, res) => {
  try {
    const params = await ticketParams(req);
    const severities = severityLabels(toArray(req.query.severity));
    const anchor = await ticketHealthAnchor(params.year, params.week);
    const data = await getTicketInflowHealth({
      anchor, sites: params.sites, products: params.products, severities,
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/ticket-backlog', async (req, res) => {
  try {
    const params = await ticketParams(req);
    const anchor = await ticketHealthAnchor(params.year, params.week);
    const data = await getTicketBacklogHealth({ anchor, sites: params.sites, products: params.products });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/ticket-resolution', async (req, res) => {
  try {
    const params = await ticketParams(req);
    const anchor = await ticketHealthAnchor(params.year, params.week);
    const data = await getTicketResolutionHealth({ anchor, sites: params.sites, products: params.products });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/uptime', async (req, res) => {
  try {
    const data = await getUptimeData(await uptimeMtbfParams(req));
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/mtbf', async (req, res) => {
  try {
    const data = await getMtbfData(await uptimeMtbfParams(req));
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/stability-filters', async (req, res) => {
  try {
    const data = await getStabilityFilterOptions();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`CritSit dashboard running at http://localhost:${PORT}`);
});
