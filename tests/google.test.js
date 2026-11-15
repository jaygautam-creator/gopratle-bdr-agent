const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const S = require('../src/store.js');
const M = require('../src/mailer.js');

// ---- in-memory fake of the Google Sheets v4 + OAuth endpoints (only what we use)
function fakeGoogle() {
  const g = { sheets: { Leads: [S.COLS.slice()], Activity_log: [['timestamp', 'request_id', 'step', 'level', 'message']], Config: [['key', 'value', 'description'], ['followup_delay_minutes', '7', 'x']] }, calls: [], tokenCalls: 0 };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  g.publicKey = publicKey; g.privateKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const colIdx = (a1) => { const m = /^([A-Z]+)(\d+)$/.exec(a1); let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return [n - 1, +m[2]]; };
  g.http = async (req) => {
    const url = decodeURIComponent(req.url); g.calls.push(req.method + ' ' + url.replace(/https:\/\/[^/]+/, '').split('?')[0]);
    if (/oauth2\.googleapis\.com\/token/.test(url)) {
      g.tokenCalls++;
      if (/refresh_token/.test(req.body || '')) return g.badRefresh ? { status: 400, json: { error: 'invalid_grant' } } : { status: 200, json: { access_token: 'gmail-tok', expires_in: 3600 } };
      const jwt = /assertion=(.+)$/.exec(req.body)[1]; const [h, c, sig] = jwt.split('.');
      const ok = crypto.createVerify('RSA-SHA256').update(h + '.' + c).verify(g.publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
      g.lastClaim = JSON.parse(Buffer.from(c, 'base64url').toString());
      return ok ? { status: 200, json: { access_token: 'sheets-tok', expires_in: 3600 } } : { status: 401, json: {} };
    }
    if (/sheets\.googleapis\.com/.test(url)) {
      if (req.headers.Authorization !== 'Bearer sheets-tok') return { status: 401, json: { error: { message: 'bad token' } } };
      const body = req.body;
      let m;
      if (req.method === 'GET' && /spreadsheets\/SID\?fields/.test(url)) return { status: 200, json: { sheets: Object.keys(g.sheets).map((t) => ({ properties: { title: t } })) } };
      if (/SID:batchUpdate/.test(url)) { for (const r of body.requests) g.sheets[r.addSheet.properties.title] = []; return { status: 200, json: {} }; }
      if (req.method === 'PUT' && (m = /\/values\/(\w+)!A1\?/.exec(url))) { g.sheets[m[1]][0] = body.values[0]; return { status: 200, json: {} }; }
      if ((m = /\/values\/(\w+)!A(\d+):?[A-Z]*\d*:append/.exec(url)) || (m = /\/values\/(\w+)!A1:append/.exec(url))) { for (const row of body.values) g.sheets[m[1]].push(row); return { status: 200, json: {} }; }
      if (/values:batchUpdate/.test(url)) { for (const d of body.data) { const [sh, cell] = d.range.split('!'); const [c, r] = colIdx(cell); const rows = g.sheets[sh]; while (rows.length < r) rows.push([]); rows[r - 1][c] = d.values[0][0]; } return { status: 200, json: {} }; }
      if (req.method === 'PUT' && (m = /\/values\/(\w+)!B(\d+)/.exec(url))) { g.sheets[m[1]][+m[2] - 1][1] = body.values[0][0]; return { status: 200, json: {} }; }
      if (req.method === 'GET' && (m = /\/values\/(\w+)!A(\d+):/.exec(url))) { return { status: 200, json: { values: g.sheets[m[1]].slice(+m[2] - 1) } }; }
    }
    return { status: 404, json: { error: { message: 'unhandled ' + url } } };
  };
  return g;
}
const saB64 = (g) => Buffer.from(JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: g.privateKey })).toString('base64');
const mk = (g) => new S.SheetsStore({ http: g.http, env: { GOOGLE_SHEET_ID: 'SID', GOOGLE_SERVICE_ACCOUNT_B64: saB64(g) } });

test('sheets: service-account JWT is correctly signed and scoped', async () => {
  const g = fakeGoogle(); const s = mk(g);
  await s.all();
  assert.equal(g.lastClaim.iss, 'bot@proj.iam.gserviceaccount.com');
  assert.equal(g.lastClaim.scope, 'https://www.googleapis.com/auth/spreadsheets');
  assert.equal(g.lastClaim.aud, 'https://oauth2.googleapis.com/token');
  await s.all(); assert.equal(g.tokenCalls, 1, 'token is cached across calls');
});

test('sheets: append, adopt hand-typed rows, update only changed cells, read back', async () => {
  const g = fakeGoogle(); const s = mk(g);
  await s.append({ request_id: 'LD-0001', company: 'Zomato', city: 'Gurgaon', status: 'SENT' });
  g.sheets.Leads.push(['', '', 'Swiggy', 'Bengaluru']); // a person typed this row by hand
  assert.equal(await s.adoptManualRows(), 1);
  let rows = await s.all();
  assert.equal(rows.length, 2); assert.equal(rows[1].request_id, 'LD-0002'); assert.equal(rows[1].status, 'NEW'); assert.equal(rows[1].source, 'sheet');
  await s.update('LD-0002', { status: 'PROCESSING', attempts: '1' });
  rows = await s.all(); assert.equal(rows[1].status, 'PROCESSING'); assert.equal(rows[1].company, 'Swiggy', 'untouched cells are preserved');
  assert.equal(await s.nextId(), 'LD-0003');
  await assert.rejects(() => s.update('LD-9999', {}), /not found/);
});

test('sheets: tolerates a reordered header and extra columns', async () => {
  const g = fakeGoogle(); const s = mk(g);
  g.sheets.Leads[0] = ['notes_extra', 'company', 'request_id', 'status', 'city'];
  g.sheets.Leads.push(['hi', 'Acme', 'LD-0001', 'NEW', 'Pune']);
  await s.update('LD-0001', { status: 'SENT' });
  assert.deepEqual(g.sheets.Leads[1].slice(0, 5), ['hi', 'Acme', 'LD-0001', 'SENT', 'Pune']);
});

test('sheets: config tab overrides, meta state round-trips, activity log batches', async () => {
  const g = fakeGoogle(); const s = mk(g);
  assert.equal((await s.getConfig()).followup_delay_minutes, '7');
  assert.equal(await s.getMeta('tg_offset'), undefined);
  await s.setMeta('tg_offset', 42); await s.setMeta('tg_offset', 43);
  assert.equal(await s.getMeta('tg_offset'), '43'); assert.ok(!('_tg_offset' in await s.getConfig()), 'internal keys are hidden from config');
  await s.logMany([{ request_id: 'LD-1', step: 'a', message: 'x' }, { request_id: 'LD-1', step: 'b', message: 'y' }]);
  assert.equal(g.sheets.Activity_log.length, 3);
  assert.equal(g.calls.filter((c) => /Activity_log/.test(c)).length, 1, 'one API call for many log lines');
});

test('sheets: clear errors for bad credentials / missing config', async () => {
  const g = fakeGoogle(); const bad = new S.SheetsStore({ http: g.http, env: { GOOGLE_SHEET_ID: 'S', GOOGLE_SERVICE_ACCOUNT_B64: Buffer.from(JSON.stringify({ client_email: 'x', private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) })).toString('base64') } });
  await assert.rejects(() => bad.all(), /Google auth failed/);
  assert.throws(() => new S.SheetsStore({ http: g.http, env: {} }), /GOOGLE_SHEET_ID/);
});

test('store factory picks the backend from env and rejects unknown ones', () => {
  assert.equal(S.makeStore({ env: { STORE_BACKEND: 'local', DATA_DIR: require('node:os').tmpdir() + '/x' }, fs: require('node:fs') }).name, 'local');
  assert.throws(() => S.makeStore({ env: { STORE_BACKEND: 'mongo' } }), /Unknown STORE_BACKEND/);
});

// ---- Gmail
function fakeGmail() {
  const g = { sent: [], threads: {}, me: 'sender@gmail.com', refreshCalls: 0 };
  g.http = async (req) => {
    const url = req.url;
    if (/oauth2\.googleapis\.com\/token/.test(url)) { g.refreshCalls++; return g.badRefresh ? { status: 400, json: { error: 'invalid_grant' } } : { status: 200, json: { access_token: 'tok', expires_in: 3600 } }; }
    if (req.headers.Authorization !== 'Bearer tok') return { status: 401, json: {} };
    if (/users\/me\/profile/.test(url)) return { status: 200, json: { emailAddress: g.me } };
    if (/messages\/send/.test(url)) { const tid = req.body.threadId || 'T' + (g.sent.length + 1); g.sent.push({ ...req.body, threadId: tid }); g.threads[tid] = (g.threads[tid] || []).concat([{ payload: { headers: [{ name: 'From', value: g.me }] } }]); return { status: 200, json: { id: 'M' + g.sent.length, threadId: tid } }; }
    if (/users\/me\/threads\//.test(url)) return { status: 200, json: { messages: g.threads[decodeURIComponent(url.split('/threads/')[1].split('?')[0])] || [] } };
    return { status: 404, json: {} };
  };
  return g;
}
const gm = (g, extra = {}) => new M.GmailMailer({ http: g.http, env: { GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 's', GMAIL_REFRESH_TOKEN: 'r', SEND_ALLOWLIST: 'a@b.com,lead@x.com', ...extra } });

test('gmail: sends a well-formed RFC822 message and returns the thread id', async () => {
  const g = fakeGmail(); const m = gm(g);
  const r = await m.send({ to: 'lead@x.com', subject: 'Event crew — for Acme', body: 'Hi\nthere' });
  assert.equal(r.threadId, 'T1');
  const raw = Buffer.from(g.sent[0].raw, 'base64url').toString('utf8');
  assert.match(raw, /^From: sender@gmail\.com\r\nTo: lead@x\.com\r\nSubject: =\?UTF-8\?B\?/); // non-ASCII subject is RFC2047-encoded
  assert.match(raw, /\r\n\r\nHi\nthere$/);
});

test('gmail: follow-up reuses the thread; reply detection ignores our own messages', async () => {
  const g = fakeGmail(); const m = gm(g);
  const first = await m.send({ to: 'a@b.com', subject: 's', body: 'b' });
  assert.equal(await m.hasReply(first.threadId), false);
  const fu = await m.send({ to: 'a@b.com', subject: 'Re: s', body: 'b2', threadId: first.threadId });
  assert.equal(fu.threadId, first.threadId); assert.equal(await m.hasReply(first.threadId), false);
  g.threads[first.threadId].push({ payload: { headers: [{ name: 'From', value: 'Lead <lead@x.com>' }] } });
  assert.equal(await m.hasReply(first.threadId), true);
});

test('gmail: revoked refresh token gives a clear error; missing config fails fast', async () => {
  const g = fakeGmail(); g.badRefresh = true;
  await assert.rejects(() => gm(g).send({ to: 'a@b.com', subject: 's', body: 'b' }), /Gmail auth failed/);
  assert.throws(() => new M.GmailMailer({ http: g.http, env: {} }), /GMAIL_CLIENT_ID/);
});

test('mailer: opt-out line, sandbox banner and placeholder guard', () => {
  const lead = { lead_name: 'Priya Sharma', email: 'p@acme.com', email_source: 'guessed', subject: 'S', pitch: 'Hi Priya, a\nb\nc', followup_text: 'f' };
  const r = M.resolveRecipient(lead, { sandbox_mode: 'true', sandbox_inbox: 'qa@gmail.com' }, {});
  const c = M.compose(lead, 'outreach', { sender_name: 'Jay' }, r);
  assert.match(c.body, /^\[SANDBOX\] Intended for: Priya Sharma <p@acme\.com> \(guessed\)/); assert.match(c.body, /Jay\nGoPratle/);
  assert.equal((c.body.match(/Hi Priya/g) || []).length, 1, 'no double greeting');
  assert.throws(() => M.resolveRecipient(lead, { sandbox_mode: 'true', sandbox_inbox: 'your.test.inbox@gmail.com' }, {}), /placeholder/);
  assert.throws(() => M.resolveRecipient(lead, { sandbox_mode: 'true', sandbox_inbox: '' }, {}), /SANDBOX_INBOX/);
});

test('sheets: ensureSchema builds a blank spreadsheet, and is idempotent', async () => {
  const g = fakeGoogle(); g.sheets = { Sheet1: [[]] }; const s = mk(g);
  const r1 = await s.ensureSchema();
  assert.deepEqual(r1.created, ['Leads', 'Activity_log', 'Config']); assert.deepEqual(r1.headers, ['Leads', 'Activity_log', 'Config']); assert.equal(r1.seeded, true);
  assert.deepEqual(g.sheets.Leads[0], S.COLS); assert.equal(g.sheets.Config[1][0], 'sandbox_mode');
  const r2 = await s.ensureSchema();
  assert.deepEqual(r2, { created: [], headers: [], seeded: false, missing_columns: [] });
  assert.equal(g.sheets.Config.length, 1 + Object.keys(S.DEFAULT_CONFIG).length, 'config not seeded twice');
});

test('sheets: ensureSchema never overwrites existing data and reports missing columns', async () => {
  const g = fakeGoogle(); const s = mk(g);
  g.sheets.Leads[0] = ['request_id', 'company', 'city']; g.sheets.Leads.push(['LD-0001', 'Acme', 'Pune']);
  const r = await s.ensureSchema();
  assert.ok(r.missing_columns.includes('status')); assert.deepEqual(g.sheets.Leads[1], ['LD-0001', 'Acme', 'Pune']);
  assert.equal(r.seeded, false, 'existing Config values are kept');
});

test('send lock: gmail refuses to send without SEND_ALLOWLIST, or to anyone not on it', async () => {
  const g = fakeGmail();
  await assert.rejects(() => gm(g, { SEND_ALLOWLIST: '' }).send({ to: 'a@b.com', subject: 's', body: 'b' }), /SEND_ALLOWLIST is empty/);
  await assert.rejects(() => gm(g).send({ to: 'stranger@corp.com', subject: 's', body: 'b' }), /Blocked: stranger@corp.com/);
  assert.equal(g.sent.length, 0, 'nothing reached the Gmail API');
  await gm(g).send({ to: 'A@B.com ', subject: 's', body: 'b' }); assert.equal(g.sent.length, 1, 'allow-list match is case/space insensitive');
});

test('send lock: dry-run mailer honours an allow-list when one is set', async () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dr-'));
  const m = new M.DryRunMailer({ env: { DATA_DIR: dir, SEND_ALLOWLIST: 'me@gmail.com' }, fs: require('node:fs') });
  await assert.rejects(() => m.send({ to: 'x@y.com', subject: 's', body: 'b', requestId: 'LD-1' }), /not in SEND_ALLOWLIST/);
  await m.send({ to: 'me@gmail.com', subject: 's', body: 'b', requestId: 'LD-1' });
});
