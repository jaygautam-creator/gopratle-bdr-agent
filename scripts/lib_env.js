// Shared bootstrap for CLI scripts: load .env, provide a fetch-based http adapter.
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const env = {};
  const file = path.join(__dirname, '..', '.env');
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
  return { ...env, ...process.env };
}

async function http({ method = 'GET', url, headers = {}, body, timeoutMs = 20000 }) {
  const res = await fetch(url, { method, headers, body: body && typeof body !== 'string' ? JSON.stringify(body) : body, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = undefined; }
  return { status: res.status, json, text };
}
module.exports = { loadEnv, http, fs };
