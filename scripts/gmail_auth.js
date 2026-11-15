#!/usr/bin/env node
// One-time Gmail login. Opens Google's consent screen, receives the code on localhost, and writes
// GMAIL_REFRESH_TOKEN into .env (never printed).  Needs GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET in .env
// and http://localhost:8085/callback registered as an authorised redirect URI.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { loadEnv } = require('./lib_env.js');

const env = loadEnv();
if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) { console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first (see docs/setup-google.md).'); process.exit(1); }
const redirect = 'http://localhost:8085/callback';
const scope = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly';
const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope, access_type: 'offline', prompt: 'consent' });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:8085');
  if (u.pathname !== '/callback') { res.end('waiting'); return; }
  const code = u.searchParams.get('code');
  if (!code) { res.end('No code received: ' + (u.searchParams.get('error') || '')); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }) });
  const j = await r.json();
  if (!j.refresh_token) { res.end('Google returned no refresh token: ' + JSON.stringify(j.error_description || j.error)); console.error('No refresh token:', j.error_description || j.error); server.close(); return; }
  const file = path.join(__dirname, '..', '.env');
  let text = fs.readFileSync(file, 'utf8');
  text = /^GMAIL_REFRESH_TOKEN=/m.test(text) ? text.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, () => 'GMAIL_REFRESH_TOKEN=' + j.refresh_token) : text.trimEnd() + '\nGMAIL_REFRESH_TOKEN=' + j.refresh_token + '\n';
  fs.writeFileSync(file, text);
  res.end('Done. You can close this tab and return to the terminal.');
  console.log('GMAIL_REFRESH_TOKEN saved to .env. Next: set MAIL_BACKEND=gmail.');
  server.close();
});
server.listen(8085, () => { console.log('Opening Google consent screen...\nIf it does not open, visit:\n' + url); execFile('open', [url], () => {}); });
