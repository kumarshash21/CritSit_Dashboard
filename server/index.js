import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { getCaseListView, getTicketHistory, getTrendData, getTrendDayDetail } from './salesforce.js';
import { dayKeyInZone, isValidTimeZone, zonedMidnightUtc } from './tz.js';

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

app.listen(PORT, () => {
  console.log(`CritSit dashboard running at http://localhost:${PORT}`);
});
