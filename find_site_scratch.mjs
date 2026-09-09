import 'dotenv/config';
import { BigQuery } from '@google-cloud/bigquery';

const bigquery = new BigQuery({ projectId: process.env.GCLOUD_PROJECT_ID });
const table = `\`${process.env.GCLOUD_PROJECT_ID}.sw_support_v1.uptime_main\``;

function uptimePct(ops, down) {
  return ops > 0 ? ((ops - down) / ops) * 100 : null;
}

const [rows] = await bigquery.query({
  query: `
    SELECT
      Year,
      Product,
      SUM(Operations_hr) AS ops_hr,
      SUM(IFNULL(Software_Downtime_hr,0)) AS downtime_hr
    FROM ${table}
    WHERE Site = 'Sams Club ATL' AND Week_Num = 35
    GROUP BY Year, Product
    ORDER BY Year, Product
  `,
});

const byYear = {};
for (const r of rows) {
  byYear[r.Year] ??= [];
  byYear[r.Year].push(r);
}

for (const year of Object.keys(byYear).sort()) {
  console.log(`\n=== Year ${year}, Week 35 ===`);
  let totalOps = 0, totalDown = 0;
  for (const r of byYear[year]) {
    const ops = Number(r.ops_hr), down = Number(r.downtime_hr);
    totalOps += ops; totalDown += down;
    const pct = uptimePct(ops, down);
    console.log(`  ${r.Product}: ops=${ops.toFixed(2)}h down=${down.toFixed(2)}h uptime=${pct === null ? 'N/A' : pct.toFixed(3) + '%'}`);
  }
  console.log(`  OVERALL (all products): ops=${totalOps.toFixed(2)}h down=${totalDown.toFixed(2)}h uptime=${uptimePct(totalOps, totalDown).toFixed(3)}%`);
}
