// Orchestration: everything the n8n workflows do, as plain async functions over ports
// (http, store, mailer). Each workflow node calls exactly one of these, so the same code is
// exercised by unit tests, the local CLI and n8n.

const R = (n) => (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./' + n + '.js') : null;
const L = R('lib') || lib, P = R('pipeline') || pipeline, T = R('telegram') || telegram, S = R('store') || store, M = R('mailer') || mailer;

const DONE_OR_ACTIVE = ['NEW', 'PROCESSING', 'AWAITING_APPROVAL', 'READY_TO_SEND', 'SENT', 'FOLLOWED_UP', 'REPLIED', 'NEEDS_REVIEW'];
const STUCK_MS = 15 * 60 * 1000;
const iso = (d) => (d || new Date()).toISOString();

function makeCtx({ http, env, fs, crypto, sleep }) {
  const ctx = { http, env, fs, crypto, sleep, log: [], config: {} };
  ctx.store = S.makeStore(ctx);
  ctx.mailer = M.makeMailer(ctx);
  return ctx;
}

async function loadConfig(ctx) {
  const e = ctx.env;
  const c = { ...S.DEFAULT_CONFIG, ...(e.REQUIRE_APPROVAL ? { require_approval: e.REQUIRE_APPROVAL } : {}), sandbox_mode: e.SANDBOX_MODE || 'true', sandbox_inbox: e.SANDBOX_INBOX || '', followup_delay_minutes: e.FOLLOWUP_DELAY_MINUTES || '2' };
  const sheet = await ctx.store.getConfig();
  for (const [k, v] of Object.entries(sheet)) if (String(v).trim() !== '') c[k] = String(v).trim();
  ctx.config = c;
  return c;
}
// Fail closed: approval is required unless explicitly switched off.
const needsApproval = (cfg) => !/^(false|no|0|off)$/i.test(String((cfg && cfg.require_approval) == null ? 'true' : cfg.require_approval).trim());
const adminChat = (ctx) => T.allowedChats(ctx.env)[0];
const notifyChat = (ctx, row) => row.requested_by || adminChat(ctx);
const ageMs = (t) => { const x = Date.parse(t); return isNaN(x) ? Infinity : Date.now() - x; };

// ------------------------------------------------------------------ presentation
const HELP = `GoPratle BDR bot. Send:\n  Find event leads for Zomato in Gurgaon\n  /lead Swiggy, Bengaluru\n  /status  (queue summary)  or  /status LD-0001\n  approve LD-0001  /  reject LD-0001\nI find the Founder/HR/Events contact, write a 3-line pitch and log it. Nothing is emailed until you approve it (sandbox by default).`;

function card(row, cfg, extra) {
  const L1 = [`${row.request_id}  ${row.company} (${row.city})  ->  ${row.status}`];
  if (row.lead_name || row.email) L1.push(`Contact: ${row.lead_name || 'n/a'}${row.lead_title ? ', ' + row.lead_title : ''}`);
  if (row.email) L1.push(`Email: ${row.email} (${row.email_source || 'n/a'})   Confidence: ${row.confidence}`);
  if (row.subject) L1.push(`Subject: ${row.subject}`);
  if (row.pitch) L1.push('', row.pitch);
  if (row.notes) L1.push('', 'Note: ' + row.notes);
  if (row.error) L1.push('Error: ' + row.error);
  if (extra) L1.push('', extra);
  return L1.join('\n');
}

// ------------------------------------------------------------------ Telegram intake
async function pollTelegram(ctx) {
  const offset = parseInt((await ctx.store.getMeta('tg_offset')) || '0', 10) || 0;
  const updates = await T.getUpdates(ctx, offset);
  return updates.map((u) => {
    const cq = u.callback_query; // a tap on an Approve / Reject button
    if (cq) return { update_id: u.update_id, chat_id: cq.message ? String(cq.message.chat.id) : '', text: String(cq.data || '').replace(':', ' '), is_private: !cq.message || cq.message.chat.type === 'private', callback_id: cq.id, message_id: cq.message && cq.message.message_id };
    return { update_id: u.update_id, chat_id: u.message ? String(u.message.chat.id) : '', text: (u.message && u.message.text) || '', is_private: !u.message || u.message.chat.type === 'private' };
  });
}

async function llmParse(ctx, text) {
  if (!ctx.env.GEMINI_API_KEY) return null;
  const g = await P.gemini(ctx, `Extract the company name and city from this message. Message: """${L.clean(text).slice(0, 300)}"""\nReturn JSON only: {"company":string|null,"city":string|null}. Use null if either is missing. Do not guess.`);
  if (!g || !g.data.company || !g.data.city) return null;
  const lower = L.clean(text).toLowerCase();
  const company = L.clean(g.data.company), city = L.clean(g.data.city);
  // must literally appear in the message: the LLM may not invent either value
  if (!lower.includes(company.toLowerCase()) || !lower.includes(city.toLowerCase())) return null;
  return L.parseCommand(`${company}, ${city}`);
}

async function statusReply(ctx, arg) {
  const rows = await ctx.store.all();
  if (arg) {
    const a = arg.trim().toLowerCase();
    const r = rows.find((x) => (x.request_id || '').toLowerCase() === a) || [...rows].reverse().find((x) => (x.company || '').toLowerCase().includes(a));
    return r ? card(r, ctx.config) : `No lead matching "${arg}".`;
  }
  if (!rows.length) return 'No leads yet. Send: Find event leads for Zomato in Gurgaon';
  const counts = {}; for (const r of rows) counts[r.status || 'NEW'] = (counts[r.status || 'NEW'] || 0) + 1;
  const last = rows.slice(-5).map((r) => `${r.request_id} ${r.company} (${r.city}) - ${r.status || 'NEW'}`);
  return 'Leads: ' + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') + '\n\nLatest:\n' + last.join('\n');
}

// Human approval gate: only an allow-listed chat reaches here (checked in handleOne).
async function decide(ctx, verb, id) {
  const row = (await ctx.store.all()).find((r) => (r.request_id || '').toUpperCase() === id);
  if (!row) return `No lead ${id}.`;
  if (row.status !== 'AWAITING_APPROVAL') return `${id} is ${row.status || 'NEW'}, not waiting for approval. Nothing changed.`;
  if (verb === 'reject') {
    await ctx.store.update(id, { status: 'REJECTED', notes: 'Rejected by a human; nothing sent' });
    await ctx.store.log({ request_id: id, step: 'approval', level: 'info', message: 'rejected by human' });
    return `${id} ${row.company}: rejected. Nothing was sent.`;
  }
  await ctx.store.update(id, { status: 'READY_TO_SEND', error: '' });
  await ctx.store.log({ request_id: id, step: 'approval', level: 'info', message: 'approved by human; queued to send' });
  return `${id} ${row.company}: approved. Sending within about a minute.`;
}

async function handleOne(ctx, m) {
  const allowed = T.allowedChats(ctx.env);
  if (!m.text.trim()) return null;
  if (!allowed.includes(m.chat_id)) {
    await ctx.store.log({ step: 'telegram', level: 'warn', message: 'rejected message from unauthorised chat ' + m.chat_id });
    return { chat_id: m.chat_id, text: 'Sorry, this bot is private.' };
  }
  const text = m.text.trim();
  if (/^\/(start|help)\b/i.test(text)) return { chat_id: m.chat_id, text: HELP };
  const st = /^\/status(?:@\w+)?\s*(.*)$/i.exec(text);
  if (st) return { chat_id: m.chat_id, text: await statusReply(ctx, st[1]) };

  const ap = /^\/?(approve|reject)(?:@\w+)?\s+(LD-\d+)\b/i.exec(text);
  if (ap) return { chat_id: m.chat_id, text: await decide(ctx, ap[1].toLowerCase(), ap[2].toUpperCase()) };
  if (/^\/?(approve|reject)\b/i.test(text)) return { chat_id: m.chat_id, text: 'Say which lead, e.g.  approve LD-0005  or  reject LD-0005' };

  let parsed = L.parseCommand(text);
  if (!parsed) parsed = await llmParse(ctx, text);
  if (!parsed) return { chat_id: m.chat_id, text: "I couldn't find a company and city in that.\nTry: Find event leads for Zomato in Gurgaon" };

  const cfg = ctx.config; const key = L.dedupeKey(parsed.company, parsed.city);
  const rows = await ctx.store.all();
  const dup = rows.find((r) => L.dedupeKey(r.company, r.city) === key && r.status !== 'FAILED' && ageMs(r.created_at) <= parseFloat(cfg.duplicate_window_days) * 86400000);
  if (dup) return { chat_id: m.chat_id, text: `Already have this one (${dup.request_id}, ${dup.status || 'NEW'}).\n\n` + card(dup, cfg) };

  const id = await ctx.store.nextId();
  await ctx.store.append({ request_id: id, created_at: iso(), company: parsed.company, city: parsed.city, source: 'telegram', requested_by: m.chat_id, status: 'NEW', attempts: '0', updated_at: iso() });
  await ctx.store.log({ request_id: id, step: 'intake', level: 'info', message: `queued from telegram: ${parsed.company} / ${parsed.city}` });
  return { chat_id: m.chat_id, request_id: id, text: `Queued ${id}: ${parsed.company} (${parsed.city}). I'll message you here when it's ready (about a minute).` };
}

// Handles every polled message, then commits the Telegram offset (at-least-once: a crash re-delivers, never loses).
async function handleMessages(ctx, items) {
  await loadConfig(ctx);
  const replies = [];
  let maxId = -1;
  for (const m of items) {
    maxId = Math.max(maxId, m.update_id);
    try { const r = await handleOne(ctx, m); if (r) replies.push(m.callback_id ? { ...r, callback_id: m.callback_id, message_id: m.message_id } : r); }
    catch (e) { await ctx.store.log({ step: 'telegram', level: 'error', message: e.message }).catch(() => {}); replies.push({ chat_id: m.chat_id, text: 'Something went wrong handling that. I logged it; please try again.' }); }
  }
  if (maxId >= 0) await ctx.store.setMeta('tg_offset', maxId + 1);
  return replies;
}

// ------------------------------------------------------------------ queue processing
async function claimLeads(ctx, limit) {
  const cfg = await loadConfig(ctx); const max = parseInt(cfg.max_attempts, 10) || 3;
  await ctx.store.adoptManualRows();
  let rows = await ctx.store.all();
  const claimed = [];

  // 1. recover rows stuck in PROCESSING (a crashed run)
  for (const r of rows) {
    if (r.status === 'PROCESSING' && ageMs(r.updated_at) > STUCK_MS) {
      const failed = (parseInt(r.attempts, 10) || 0) >= max;
      await ctx.store.update(r.request_id, failed ? { status: 'FAILED', error: 'Stuck in PROCESSING; gave up after ' + max + ' attempts' } : { status: 'NEW', notes: 'recovered from a stuck run' });
      await ctx.store.log({ request_id: r.request_id, step: 'recover', level: 'warn', message: failed ? 'marked FAILED' : 'reset to NEW' });
    }
  }
  rows = await ctx.store.all();

  // 2. duplicates typed into the sheet by hand (telegram duplicates are caught at intake)
  const seen = new Map();
  for (const r of rows) { // earlier rows win
    const k = L.dedupeKey(r.company, r.city);
    const isNew = (r.status || 'NEW') === 'NEW';
    if (isNew && seen.has(k) && ageMs(seen.get(k).created_at) <= parseFloat(cfg.duplicate_window_days) * 86400000) {
      await ctx.store.update(r.request_id, { status: 'DUPLICATE', notes: 'Duplicate of ' + seen.get(k).request_id });
      r.status = 'DUPLICATE';
    } else if (DONE_OR_ACTIVE.includes(r.status || 'NEW') && !seen.has(k)) seen.set(k, r);
  }

  // 3. claim up to `limit`: rows ready to (re)send first (cheap), then NEW rows, oldest first
  const resend = rows.filter((r) => r.status === 'READY_TO_SEND');
  const fresh = rows.filter((r) => (r.status || 'NEW') === 'NEW' && r.company);
  for (const r of [...resend, ...fresh].slice(0, limit == null ? 2 : limit)) {
    const attempts = (parseInt(r.attempts, 10) || 0) + (r.status === 'READY_TO_SEND' ? 0 : 1);
    await ctx.store.update(r.request_id, { status: r.status === 'READY_TO_SEND' ? 'READY_TO_SEND' : 'PROCESSING', attempts: String(attempts) });
    claimed.push({ request_id: r.request_id, company: r.company, city: r.city, requested_by: r.requested_by, attempts, resend: r.status === 'READY_TO_SEND', row: r });
  }
  return claimed;
}

async function enrichItem(ctx, item) {
  const cfg = await loadConfig(ctx);
  if (item.resend) return { ...item, lead: { ...item.row, sources: item.row.sources }, log: [] };
  const pctx = { http: ctx.http, env: ctx.env, sleep: ctx.sleep, config: cfg, log: [] };
  const { lead, log } = await P.enrichLead(pctx, { company: item.company, city: item.city });
  return { ...item, row: undefined, lead, log };
}

const LEAD_FIELDS = ['status', 'domain', 'company_summary', 'lead_name', 'lead_title', 'linkedin_url', 'email', 'email_source', 'confidence', 'sources', 'alt_contacts', 'subject', 'pitch', 'followup_text', 'notes', 'error'];

async function saveAndSend(ctx, item) {
  const cfg = await loadConfig(ctx); const max = parseInt(cfg.max_attempts, 10) || 3;
  const id = item.request_id; const lead = { ...item.lead };
  await ctx.store.logMany((item.log || []).map((l) => ({ request_id: id, step: l.step, level: l.level, message: l.msg })));

  let patch = {}; for (const k of LEAD_FIELDS) patch[k] = lead[k] == null ? '' : String(lead[k]);
  if (item.resend) { patch = { status: 'READY_TO_SEND', error: '' }; }
  let extra = '';

  if (lead.status === 'FAILED' && item.attempts < max) {
    patch.status = 'NEW'; patch.notes = `retry ${item.attempts}/${max}: ${lead.error}`; patch.error = lead.error;
    await ctx.store.update(id, patch);
    return { chat_id: null, request_id: id, status: 'NEW', text: '' }; // silent retry on the next run
  }

  if (lead.status === 'READY_TO_SEND' && !item.resend && needsApproval(cfg)) {
    patch.status = 'AWAITING_APPROVAL';
    extra = `NOT SENT. Waiting for your approval.\nTap a button below, or reply:  approve ${id}  /  reject ${id}`;
    await ctx.store.log({ request_id: id, step: 'approval', level: 'info', message: 'draft ready; waiting for human approval' });
  } else if (lead.status === 'READY_TO_SEND') {
    try {
      const rcpt = M.resolveRecipient(lead, cfg, ctx.env);
      const msg = M.compose(lead, 'outreach', cfg, rcpt);
      const res = await ctx.mailer.send({ to: rcpt.to, subject: msg.subject, body: msg.body, requestId: id });
      const now = new Date(); const due = new Date(now.getTime() + parseFloat(cfg.followup_delay_minutes) * 60000);
      patch = { ...patch, status: 'SENT', sent_at: iso(now), followup_due_at: iso(due), gmail_thread_id: res.threadId, reply_status: 'none', error: '' };
      extra = rcpt.sandbox ? `Sent to the SANDBOX inbox (${ctx.mailer.name}), not to ${lead.email}. Follow-up due ${iso(due)}.` : `Sent to ${rcpt.to}. Follow-up due ${iso(due)}.`;
      await ctx.store.log({ request_id: id, step: 'send', level: 'info', message: `sent via ${ctx.mailer.name} to ${rcpt.to}` });
    } catch (e) {
      patch = { ...patch, status: 'READY_TO_SEND', error: 'Send failed: ' + e.message.slice(0, 160) };
      extra = 'Send failed, will retry next run.';
      await ctx.store.log({ request_id: id, step: 'send', level: 'error', message: e.message });
    }
  } else if (lead.status === 'NEEDS_REVIEW') extra = 'Not sent. To approve manually: set status to READY_TO_SEND in the Sheet.';
  else if (lead.status === 'NOT_FOUND') extra = 'Nothing sent.';

  await ctx.store.update(id, patch);
  const row = { ...lead, ...patch, request_id: id, company: item.company, city: item.city };
  const buttons = patch.status === 'AWAITING_APPROVAL' ? [[{ text: '✅ Approve & send', callback_data: 'approve:' + id }, { text: '❌ Reject', callback_data: 'reject:' + id }]] : undefined;
  return { chat_id: notifyChat(ctx, item), request_id: id, status: patch.status, text: card(row, cfg, extra), buttons };
}

// ------------------------------------------------------------------ follow-ups
async function dueFollowups(ctx, limit) {
  await loadConfig(ctx);
  const now = Date.now();
  return (await ctx.store.all()).filter((r) => r.status === 'SENT' && !r.followup_sent_at && Date.parse(r.followup_due_at) <= now).slice(0, limit == null ? 5 : limit)
    .map((r) => ({ request_id: r.request_id, row: r }));
}

async function runFollowup(ctx, item) {
  const cfg = await loadConfig(ctx); const r = item.row; const id = r.request_id;
  let replied;
  try { replied = await ctx.mailer.hasReply(r.gmail_thread_id); }
  catch (e) { // never follow up blindly if we cannot tell whether they replied
    await ctx.store.log({ request_id: id, step: 'followup', level: 'warn', message: 'reply check failed, will retry: ' + e.message });
    return { chat_id: null, request_id: id, status: 'SENT', text: '' };
  }
  if (replied) {
    await ctx.store.update(id, { status: 'REPLIED', reply_status: 'replied' });
    await ctx.store.log({ request_id: id, step: 'followup', level: 'info', message: 'reply detected; follow-up cancelled' });
    return { chat_id: notifyChat(ctx, r), request_id: id, status: 'REPLIED', text: `${id} ${r.company}: ${r.lead_name || 'the lead'} replied. Follow-up cancelled. Over to a human.` };
  }
  try {
    const rcpt = M.resolveRecipient(r, cfg, ctx.env);
    const msg = M.compose(r, 'followup', cfg, rcpt);
    await ctx.mailer.send({ to: rcpt.to, subject: msg.subject, body: msg.body, threadId: r.gmail_thread_id, requestId: id });
    await ctx.store.update(id, { status: 'FOLLOWED_UP', followup_sent_at: iso(), reply_status: 'no reply' });
    await ctx.store.log({ request_id: id, step: 'followup', level: 'info', message: 'follow-up sent in the same thread' });
    return { chat_id: notifyChat(ctx, r), request_id: id, status: 'FOLLOWED_UP', text: `${id} ${r.company}: no reply yet, follow-up sent in the same thread${rcpt.sandbox ? ' (sandbox inbox)' : ''}.` };
  } catch (e) {
    await ctx.store.log({ request_id: id, step: 'followup', level: 'error', message: e.message });
    return { chat_id: null, request_id: id, status: 'SENT', text: '' };
  }
}

const errorText = (wf, node, msg) => `ALERT: workflow "${wf}" failed at node "${node}".\n${String(msg).slice(0, 500)}`;

const api = { needsApproval, decide, makeCtx, loadConfig, pollTelegram, handleMessages, claimLeads, enrichItem, saveAndSend, dueFollowups, runFollowup, statusReply, card, errorText, adminChat, HELP };
if (typeof module !== 'undefined') module.exports = api;
