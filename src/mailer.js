// Mail port. Backends: GmailMailer (Gmail REST + OAuth refresh token) and DryRunMailer (files in an outbox).
// Safety rule lives HERE, not in the workflows: unless SANDBOX_MODE is "false" AND ALLOW_REAL_SEND is "true",
// every message is redirected to SANDBOX_INBOX. No workflow can bypass it.

const L = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./lib.js') : lib;

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const encHeader = (s) => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';

function resolveRecipient(lead, cfg, env) {
  const sandbox = String(cfg.sandbox_mode).toLowerCase() !== 'false' || String(env.ALLOW_REAL_SEND).toLowerCase() !== 'true';
  const inbox = cfg.sandbox_inbox || env.SANDBOX_INBOX;
  if (sandbox) {
    if (!inbox || /^your[.@]|@example\.|test\.inbox/i.test(inbox)) throw new Error('SANDBOX_INBOX is not set to a real address (still the placeholder?)');
    return { to: inbox, sandbox: true };
  }
  if (!lead.email) throw new Error('Lead has no email');
  return { to: lead.email, sandbox: false };
}

function compose(lead, kind, cfg, rcpt) {
  const first = L.clean(lead.lead_name).split(' ')[0] || 'there';
  const sender = L.clean(cfg.sender_name) || 'The GoPratle team';
  const lines = kind === 'followup' ? [L.clean(lead.followup_text)] : String(lead.pitch).split('\n').map(L.clean).filter(Boolean);
  const greet = /^hi\b|^hello\b|^dear\b/i.test(lines[0] || '') ? [] : [`Hi ${first},`, ''];
  const banner = rcpt.sandbox ? [`[SANDBOX] Intended for: ${lead.lead_name || 'Events/HR team'} <${lead.email}> (${lead.email_source || 'n/a'}). Delivered to the test inbox instead.`, ''] : [];
  const body = [...banner, ...greet, ...lines, '', 'Best,', sender, 'GoPratle', '', '--', 'Not relevant? Reply "stop" and I will not follow up.'].join('\n');
  const subject = kind === 'followup' ? 'Re: ' + lead.subject : lead.subject;
  return { subject, body };
}

function rfc822({ from, to, subject, body }) {
  return ['From: ' + from, 'To: ' + to, 'Subject: ' + encHeader(subject), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', body].join('\r\n');
}

class GmailMailer {
  constructor(ctx) {
    this.ctx = ctx; this.name = 'gmail';
    for (const k of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) if (!ctx.env[k]) throw new Error(k + ' is not set');
  }
  async _token() {
    if (this._tok && this._tok.exp > Date.now() + 60000) return this._tok.v;
    const e = this.ctx.env;
    const r = await this.ctx.http({ method: 'POST', url: 'https://oauth2.googleapis.com/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${encodeURIComponent(e.GMAIL_CLIENT_ID)}&client_secret=${encodeURIComponent(e.GMAIL_CLIENT_SECRET)}&refresh_token=${encodeURIComponent(e.GMAIL_REFRESH_TOKEN)}&grant_type=refresh_token` });
    if (r.status !== 200 || !r.json || !r.json.access_token) throw new Error('Gmail auth failed (' + r.status + '): refresh token may be revoked or expired');
    this._tok = { v: r.json.access_token, exp: Date.now() + (r.json.expires_in || 3600) * 1000 };
    return this._tok.v;
  }
  async _gm(method, path, body) {
    const r = await this.ctx.http({ method, url: 'https://gmail.googleapis.com/gmail/v1/users/me' + path, headers: { Authorization: 'Bearer ' + await this._token(), 'Content-Type': 'application/json' }, body });
    if (r.status >= 400) throw new Error('Gmail API ' + r.status + ': ' + ((r.json && r.json.error && r.json.error.message) || '').slice(0, 160));
    return r.json || {};
  }
  async me() { if (!this._me) this._me = ((await this._gm('GET', '/profile')).emailAddress || '').toLowerCase(); return this._me; }
  async send({ to, subject, body, threadId }) {
    const from = await this.me();
    const raw = b64u(rfc822({ from, to, subject, body }));
    const d = await this._gm('POST', '/messages/send', threadId ? { raw, threadId } : { raw });
    return { id: d.id, threadId: d.threadId };
  }
  // true when anyone other than us has written in the thread
  async hasReply(threadId) {
    const me = await this.me();
    const d = await this._gm('GET', '/threads/' + encodeURIComponent(threadId) + '?format=metadata&metadataHeaders=From');
    return (d.messages || []).some((m) => { const f = (((m.payload || {}).headers || []).find((h) => /^from$/i.test(h.name)) || {}).value || ''; return f && !f.toLowerCase().includes(me); });
  }
}

class DryRunMailer {
  constructor(ctx) { this.ctx = ctx; this.name = 'dryrun'; this.fs = ctx.fs || require('fs'); this.dir = (ctx.env.DATA_DIR || './n8n_data/bdr'); }
  async send({ to, subject, body, threadId, requestId }) {
    this.fs.mkdirSync(this.dir + '/outbox', { recursive: true });
    const id = (threadId || 'dry-' + requestId);
    const n = this.fs.readdirSync(this.dir + '/outbox').filter((f) => f.startsWith(id + '__')).length + 1;
    this.fs.writeFileSync(`${this.dir}/outbox/${id}__${n}.json`, JSON.stringify({ to, subject, body, threadId: id, sent_at: new Date().toISOString() }, null, 2));
    return { id: id + '__' + n, threadId: id };
  }
  // To simulate a lead replying in a demo: touch <DATA_DIR>/replies/<request_id>
  async hasReply(threadId) { return this.fs.existsSync(`${this.dir}/replies/${String(threadId).replace(/^dry-/, '')}`); }
}

function makeMailer(ctx) {
  const b = (ctx.env.MAIL_BACKEND || 'dryrun').toLowerCase();
  if (b === 'gmail') return new GmailMailer(ctx);
  if (b !== 'dryrun') throw new Error('Unknown MAIL_BACKEND: ' + b);
  return new DryRunMailer(ctx);
}

const api = { resolveRecipient, compose, rfc822, b64u, GmailMailer, DryRunMailer, makeMailer };
if (typeof module !== 'undefined') module.exports = api;
