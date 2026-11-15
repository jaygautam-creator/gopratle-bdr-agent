#!/usr/bin/env node
// One-time Sheet setup: creates the Leads / Activity_log / Config tabs if missing, writes headers into
// empty ones and seeds Config. Safe to run repeatedly; never overwrites existing data.
//   node scripts/init_sheet.js
const { loadEnv, http, fs } = require('./lib_env.js');
const S = require('../src/store.js');

(async () => {
  const env = { ...loadEnv(), STORE_BACKEND: 'sheets' };
  const store = S.makeStore({ http, env, fs, crypto: require('crypto') });
  const r = await store.ensureSchema();
  console.log('tabs created:        ', r.created.join(', ') || 'none (already there)');
  console.log('headers written to:  ', r.headers.join(', ') || 'none (already there)');
  console.log('Config seeded:       ', r.seeded ? 'yes' : 'no (already has values)');
  if (r.missing_columns.length) console.log('WARNING: Leads header is missing columns:', r.missing_columns.join(', '));
  console.log('Sheet is ready.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
