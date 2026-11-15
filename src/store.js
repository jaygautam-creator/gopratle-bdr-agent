// Storage port. Two interchangeable backends behind one async interface:
//   LocalStore  - JSON file (default; zero setup, used for local testing and as an offline fallback)
//   SheetsStore - Google Sheets REST API with a service account (the production backend the brief asks for)
// The status column of the Leads table is the job queue; see docs/architecture.md.

const L = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./lib.js') : lib;

const COLS = ['request_id', 'created_at', 'company', 'city', 'source', 'requested_by', 'status', 'attempts', 'domain',
  'company_summary', 'lead_name', 'lead_title', 'linkedin_url', 'email', 'email_source', 'confidence', 'sources',
  'alt_contacts', 'subject', 'pitch', 'followup_text', 'sent_at', 'followup_due_at', 'followup_sent_at',
  'gmail_thread_id', 'reply_status', 'notes', 'error', 'updated_at'];

const DEFAULT_CONFIG = { sandbox_mode: 'true', sandbox_inbox: '', followup_delay_minutes: '2', min_confidence: '0.6',
  duplicate_window_days: '30', max_attempts: '3', sender_name: '', require_approval: 'true' };

const CONFIG_HELP = {
  sandbox_mode: 'true = every email goes to sandbox_inbox, never to the real lead',
  sandbox_inbox: 'Test inbox that receives all outreach in sandbox mode (overrides .env if filled)',
  followup_delay_minutes: 'Demo: 2. Production: 4320 (3 days)',
  require_approval: 'true = a human must reply approve LD-xxxx in Telegram before any email is sent (anything but false keeps it on)',
  min_confidence: 'Below this the lead goes to NEEDS_REVIEW instead of being sent',
  duplicate_window_days: 'Same company+city within this window is marked DUPLICATE',
  max_attempts: 'Attempts before a lead is marked FAILED',
  sender_name: 'Name used to sign outreach emails' };
const ACTIVITY_COLS = ['timestamp', 'request_id', 'step', 'level', 'message'];
const blank = () => Object.fromEntries(COLS.map((c) => [c, '']));
const pad = (n) => String(n).padStart(4, '0');
function nextIdFrom(rows) {
  let max = 0;
  for (const r of rows) { const m = /^LD-(\d+)$/.exec(r.request_id || ''); if (m) max = Math.max(max, +m[1]); }
  return 'LD-' + pad(max + 1);
}

// ------------------------------------------------------------------ LocalStore
class LocalStore {
  constructor(fs, dir) { this.fs = fs; this.dir = dir; this.file = dir + '/store.json'; this.name = 'local'; }
  _load() {
    try { return JSON.parse(this.fs.readFileSync(this.file, 'utf8')); }
    catch (e) { return { leads: [], activity: [], config: {}, meta: {} }; }
  }
  _save(d) {
    this.fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    this.fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    this.fs.renameSync(tmp, this.file); // atomic: a crash never leaves a half-written file
  }
  async all() { return this._load().leads; }
  async append(row) { const d = this._load(); const r = { ...blank(), ...row }; d.leads.push(r); this._save(d); return r; }
  async update(id, patch) {
    const d = this._load(); const r = d.leads.find((x) => x.request_id === id);
    if (!r) throw new Error('lead not found: ' + id);
    Object.assign(r, patch, { updated_at: new Date().toISOString() }); this._save(d); return r;
  }
  async nextId() { return nextIdFrom(this._load().leads); }
  async log(e) { const d = this._load(); d.activity.push({ timestamp: new Date().toISOString(), ...e }); if (d.activity.length > 2000) d.activity.splice(0, d.activity.length - 2000); this._save(d); }
  async activity() { return this._load().activity; }
  async getConfig() { return { ...this._load().config }; }
  async getMeta(k) { return this._load().meta[k]; }
  async setMeta(k, v) { const d = this._load(); d.meta[k] = v; this._save(d); }
  async logMany(entries) { for (const e of entries) await this.log(e); }
  // Rows people typed in by hand have no request_id/status; give them both. Returns how many were adopted.
  async adoptManualRows() {
    const d = this._load(); let n = 0;
    for (const r of d.leads) {
      if (r.company && !r.request_id) {
        r.request_id = nextIdFrom(d.leads); r.created_at = r.created_at || new Date().toISOString();
        r.source = r.source || 'sheet'; r.status = r.status || 'NEW'; r.attempts = r.attempts || '0'; n++;
      }
    }
    if (n) this._save(d); return n;
  }
}

// ------------------------------------------------------------------ SheetsStore
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function signServiceAccountJwt(sa, scope, nowSec, crypto) {
  const h = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const c = b64u(JSON.stringify({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(h + '.' + c).sign(sa.private_key);
  return h + '.' + c + '.' + b64u(sig);
}
const colLetter = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

class SheetsStore {
  constructor(ctx) {
    this.ctx = ctx; this.name = 'sheets'; this.id = ctx.env.GOOGLE_SHEET_ID;
    if (!this.id) throw new Error('GOOGLE_SHEET_ID is not set');
    if (!ctx.env.GOOGLE_SERVICE_ACCOUNT_B64) throw new Error('GOOGLE_SERVICE_ACCOUNT_B64 is not set');
    this.sa = JSON.parse(Buffer.from(ctx.env.GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
    this.header = null;
  }
  async _token() {
    if (this._tok && this._tok.exp > Date.now() + 60000) return this._tok.v;
    const crypto = this.ctx.crypto || require('crypto');
    const jwt = signServiceAccountJwt(this.sa, 'https://www.googleapis.com/auth/spreadsheets', Math.floor(Date.now() / 1000), crypto);
    const r = await this.ctx.http({ method: 'POST', url: 'https://oauth2.googleapis.com/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt });
    if (r.status !== 200 || !r.json || !r.json.access_token) throw new Error('Google auth failed (' + r.status + '): check the service account key');
    this._tok = { v: r.json.access_token, exp: Date.now() + (r.json.expires_in || 3600) * 1000 };
    return this._tok.v;
  }
  async _api(method, path, body) {
    const tok = await this._token();
    const r = await this.ctx.http({ method, url: 'https://sheets.googleapis.com/v4/spreadsheets/' + this.id + path, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body });
    if (r.status >= 400) throw new Error('Sheets API ' + r.status + ' on ' + method + ' ' + path.split('?')[0] + ': ' + ((r.json && r.json.error && r.json.error.message) || '').slice(0, 160));
    return r.json || {};
  }
  async _read() {
    const d = await this._api('GET', '/values/' + encodeURIComponent('Leads!A1:AZ5000'));
    const values = d.values || [];
    this.header = (values[0] || COLS).map((h) => String(h).trim());
    return values.slice(1).map((v, i) => { const o = blank(); this.header.forEach((h, j) => { o[h] = v[j] == null ? '' : v[j]; }); o._row = i + 2; return o; });
  }
  async all() { return (await this._read()).filter((r) => r.company); }
  async append(row) {
    const r = { ...blank(), ...row };
    await this._api('POST', '/values/' + encodeURIComponent('Leads!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { values: [COLS.map((c) => String(r[c] == null ? '' : r[c]))] });
    return r;
  }
  async update(id, patch) {
    const rows = await this._read(); const r = rows.find((x) => x.request_id === id);
    if (!r) throw new Error('lead not found: ' + id);
    const p = { ...patch, updated_at: new Date().toISOString() };
    const data = [];
    for (const [k, v] of Object.entries(p)) { const j = this.header.indexOf(k); if (j >= 0) data.push({ range: 'Leads!' + colLetter(j) + r._row, values: [[String(v == null ? '' : v)]] }); }
    await this._api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data });
    return { ...r, ...p };
  }
  async nextId() { return nextIdFrom(await this._read()); }
  async log(e) { await this._api('POST', '/values/' + encodeURIComponent('Activity_log!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { values: [[new Date().toISOString(), e.request_id || '', e.step || '', e.level || 'info', String(e.message || '').slice(0, 500)]] }); }
  async logMany(entries) {
    if (!entries.length) return;
    const ts = new Date().toISOString();
    await this._api('POST', '/values/' + encodeURIComponent('Activity_log!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
      { values: entries.map((e) => [ts, e.request_id || '', e.step || '', e.level || 'info', String(e.message || '').slice(0, 500)]) });
  }
  async adoptManualRows() {
    const rows = await this._read(); const data = []; let max = 0; let n = 0;
    for (const r of rows) { const m = /^LD-(\d+)$/.exec(r.request_id || ''); if (m) max = Math.max(max, +m[1]); }
    const ts = new Date().toISOString();
    for (const r of rows) {
      if (!r.company || r.request_id) continue;
      const set = { request_id: 'LD-' + pad(++max), created_at: r.created_at || ts, source: r.source || 'sheet', status: r.status || 'NEW', attempts: r.attempts || '0', updated_at: ts };
      for (const [k, v] of Object.entries(set)) { const j = this.header.indexOf(k); if (j >= 0) data.push({ range: 'Leads!' + colLetter(j) + r._row, values: [[v]] }); }
      n++;
    }
    if (data.length) await this._api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data });
    return n;
  }
  // Idempotent first-run setup: creates the three tabs, writes headers into empty ones, seeds Config.
  async ensureSchema() {
    const want = { Leads: COLS, Activity_log: ACTIVITY_COLS, Config: ['key', 'value', 'description'] };
    const meta = await this._api('GET', '?fields=sheets.properties.title');
    const have = new Set((meta.sheets || []).map((x) => x.properties.title));
    const created = Object.keys(want).filter((t) => !have.has(t));
    if (created.length) await this._api('POST', ':batchUpdate', { requests: created.map((title) => ({ addSheet: { properties: { title } } })) });
    const headers = []; const missing = [];
    for (const [t, cols] of Object.entries(want)) {
      const d = await this._api('GET', '/values/' + encodeURIComponent(t + '!A1:AZ1'));
      const row = (d.values && d.values[0]) || [];
      if (!row.length) { await this._api('PUT', '/values/' + encodeURIComponent(t + '!A1') + '?valueInputOption=RAW', { values: [cols] }); headers.push(t); }
      else if (t === 'Leads') for (const c of cols) if (!row.map((x) => String(x).trim()).includes(c)) missing.push(c);
    }
    const cfg = await this._api('GET', '/values/' + encodeURIComponent('Config!A2:C100'));
    let seeded = false;
    if (!(cfg.values || []).length) {
      await this._api('POST', '/values/' + encodeURIComponent('Config!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { values: Object.entries(DEFAULT_CONFIG).map(([k, v]) => [k, v, CONFIG_HELP[k] || '']) });
      seeded = true;
    }
    return { created, headers, seeded, missing_columns: missing };
  }
  async getConfig() {
    const d = await this._api('GET', '/values/' + encodeURIComponent('Config!A2:B100')); const o = {};
    for (const [k, v] of d.values || []) if (k && !String(k).startsWith('_')) o[k] = v == null ? '' : v;
    return o;
  }
  async getMeta(k) { const d = await this._api('GET', '/values/' + encodeURIComponent('Config!A2:B100')); const row = (d.values || []).find((x) => x[0] === '_' + k); return row ? row[1] : undefined; }
  async setMeta(k, v) {
    const d = await this._api('GET', '/values/' + encodeURIComponent('Config!A2:B100')); const idx = (d.values || []).findIndex((x) => x[0] === '_' + k);
    if (idx >= 0) await this._api('PUT', '/values/' + encodeURIComponent('Config!B' + (idx + 2)) + '?valueInputOption=RAW', { values: [[String(v)]] });
    else await this._api('POST', '/values/' + encodeURIComponent('Config!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { values: [['_' + k, String(v), 'internal state, do not edit']] });
  }
}

function makeStore(ctx) {
  const backend = (ctx.env.STORE_BACKEND || 'local').toLowerCase();
  if (backend === 'sheets') return new SheetsStore(ctx);
  if (backend !== 'local') throw new Error('Unknown STORE_BACKEND: ' + backend);
  return new LocalStore(ctx.fs || require('fs'), ctx.env.DATA_DIR || './n8n_data/bdr');
}

const api = { COLS, DEFAULT_CONFIG, blank, nextIdFrom, LocalStore, SheetsStore, makeStore, signServiceAccountJwt, colLetter };
if (typeof module !== 'undefined') module.exports = api;
