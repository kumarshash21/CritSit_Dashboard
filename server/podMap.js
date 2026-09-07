// Pod-list spreadsheet loader + fuzzy account→pod matcher, ported from
// app_v2.py's load_pod_map / _normalize_name / _build_pod_lookup / account_pod.
// Each column header in the sheet is a pod name; each non-empty cell below
// it is an account/site name belonging to that pod.

import ExcelJS from 'exceljs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Ships with the repo at public/Pod_list.xlsx, so this works out of the box
// on any machine/deploy; POD_LIST_PATH can still override it (e.g. prod).
const DEFAULT_POD_LIST_PATH = path.join(__dirname, '..', 'public', 'Pod_list.xlsx');
const POD_LIST_PATH = process.env.POD_LIST_PATH || DEFAULT_POD_LIST_PATH;
const CACHE_TTL_MS = 10 * 60 * 1000; // matches app_v2.py's ttl=600

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function cellToString(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((t) => t.text).join('');
    if ('result' in value) return String(value.result ?? '');
    if ('text' in value) return String(value.text ?? '');
    if (value instanceof Date) return value.toISOString();
  }
  return String(value);
}

async function loadPodMapFromDisk() {
  const filePath = expandHome(POD_LIST_PATH);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (err) {
    console.warn(`[podMap] could not read pod list at ${filePath}: ${err.message}`);
    return {};
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) return {};

  const headers = new Map(); // colNumber -> pod name
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const name = cellToString(cell.value).trim();
    if (name) headers.set(colNumber, name);
  });

  const columns = new Map(); // colNumber -> account name[]
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    for (const colNumber of headers.keys()) {
      const s = cellToString(row.getCell(colNumber).value).trim();
      if (!s) continue;
      if (!columns.has(colNumber)) columns.set(colNumber, []);
      columns.get(colNumber).push(s);
    }
  });

  const pods = {};
  for (const [colNumber, podName] of headers) {
    const values = columns.get(colNumber);
    if (values && values.length) pods[podName] = values;
  }
  return pods;
}

let cache = null; // { data, expiresAt }

/** Returns { [podName]: string[] of account names }, cached for 10 min. */
export async function getPodMap() {
  if (cache && cache.expiresAt > Date.now()) return cache.data;
  const data = await loadPodMapFromDisk();
  cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

function normalizeName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Flattens a pod map into [normalizedAccountSubstring, podName] pairs, longest-first. */
export function buildPodLookup(podMap) {
  const pairs = [];
  for (const [pod, names] of Object.entries(podMap)) {
    for (const nm of names) {
      const n = normalizeName(nm);
      if (n) pairs.push([n, pod]);
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

/** Resolves an SF account name to its pod via normalized substring matching. */
export function accountPod(accountName, lookup) {
  const n = normalizeName(accountName);
  if (!n) return null;
  for (const [needle, pod] of lookup) {
    if (n.includes(needle) || needle.includes(n)) return pod;
  }
  return null;
}
