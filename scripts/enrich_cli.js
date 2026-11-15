#!/usr/bin/env node
// Run the enrichment pipeline from the terminal against live APIs (no n8n, no Sheet, nothing is sent).
//   node scripts/enrich_cli.js "Zomato" "Gurgaon"
const fs = require('fs');
const path = require('path');
const { enrichLead } = require('../src/pipeline.js');

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

async function http({ method = 'GET', url, headers = {}, body, timeoutMs = 20000 }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (e) { json = undefined; }
    return { status: res.status, json, text };
  } finally { clearTimeout(t); }
}

(async () => {
  const [company, city] = process.argv.slice(2);
  if (!company || !city) { console.error('usage: node scripts/enrich_cli.js "<company>" "<city>"'); process.exit(2); }
  const env = { ...loadEnv(path.join(__dirname, '..', '.env')), ...process.env };
  const ctx = { http, env, config: { min_confidence: 0.6, sender_name: 'Jay' }, log: [] };
  const t0 = Date.now();
  const { lead, log } = await enrichLead(ctx, { company, city });
  console.log('--- steps ---');
  for (const l of log) console.log(`[${l.level}] ${l.step}: ${l.msg}`);
  console.log('--- result (' + ((Date.now() - t0) / 1000).toFixed(1) + 's) ---');
  console.log(JSON.stringify(lead, null, 2));
})();
