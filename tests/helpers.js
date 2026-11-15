// Test doubles: an in-memory fake of every external service, so no test touches the network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../src/agent.js');

function gem(obj) { return { status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } }; }

function fakeWorld(over = {}) {
  const w = { telegramSent: [], telegramUpdates: [], gmailSent: [], threads: {}, calls: [], ...over };
  w.http = async (req) => {
    w.calls.push(req.method + ' ' + req.url.split('?')[0]);
    const u = req.url;
    if (/api\.telegram\.org.*getUpdates/.test(u)) { const off = +(u.match(/offset=(\d+)/) || [0, 0])[1]; return { status: 200, json: { ok: true, result: w.telegramUpdates.filter((x) => x.update_id >= off) } }; }
    if (/api\.telegram\.org.*(answerCallbackQuery|editMessageReplyMarkup)/.test(u)) { (w.telegramCalls = w.telegramCalls || []).push([u.split('/').pop(), req.body]); return { status: 200, json: { ok: true } }; }
    if (/api\.telegram\.org.*sendMessage/.test(u)) { w.telegramSent.push(req.body); return { status: 200, json: { ok: true } }; }
    if (/api\.tavily\.com/.test(u)) {
      if (/official website/.test(req.body.query)) return { status: 200, json: { answer: 'Acme makes anvils.', results: [{ title: 'Acme', url: 'https://www.acme.com/', content: 'Acme anvils' }] } };
      return { status: 200, json: { results: [{ title: 'Priya Sharma - Head of Events - Acme | LinkedIn', url: 'https://in.linkedin.com/in/priya-sharma', content: 'Priya Sharma Head of Events at Acme' }] } };
    }
    if (/generativelanguage/.test(u)) {
      const prompt = req.body.contents[0].parts[0].text;
      if (/extract sales contacts/.test(prompt)) return gem({ company_size: 'large', company_summary: 'Acme makes anvils.', candidates: [{ name: 'Priya Sharma', title: 'Head of Events', source_url: 'https://in.linkedin.com/in/priya-sharma', linkedin_url: 'https://in.linkedin.com/in/priya-sharma' }] });
      if (/Extract the company name and city/.test(prompt)) return w.llmParse ? gem(w.llmParse) : gem({ company: null, city: null });
      return gem({ subject: 'Event crew for Acme', pitch_lines: ['Hi Priya, Acme runs events.', 'GoPratle connects hosts with vetted planners and DJs.', 'Open to a 10-minute chat?'], followup: 'Following up on Acme events.' });
    }
    if (/dns\.google/.test(u)) return { status: 200, json: { Answer: [{ data: 'mx' }] } };
    if (/r\.jina\.ai/.test(u)) return { status: 200, text: 'Reach us: events@acme.com' };
    if (over.extra) { const r = await over.extra(req, w); if (r) return r; }
    return { status: 404, text: '' };
  };
  return w;
}

function mkCtx(env = {}, world = fakeWorld()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdr-'));
  const ctx = A.makeCtx({ http: world.http, fs, crypto: require('crypto'), sleep: async () => {},
    env: { TAVILY_API_KEY: 't', GEMINI_API_KEY: 'g', GEMINI_MODEL_PRIMARY: 'm1', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_ALLOWED_CHAT_IDS: '111,222',
      SANDBOX_INBOX: 'qa-inbox@gmail.com', DATA_DIR: dir, STORE_BACKEND: 'local', MAIL_BACKEND: 'dryrun', FOLLOWUP_DELAY_MINUTES: '0', REQUIRE_APPROVAL: 'false', ...env } });
  return { ctx, world, dir };
}
const msg = (id, chat, text) => ({ update_id: id, message: { chat: { id: +chat, type: 'private' }, text } });
async function runIntake(ctx) { const items = await A.pollTelegram(ctx); return A.handleMessages(ctx, items); }
async function runProcess(ctx, limit = 2) { const out = []; for (const c of await A.claimLeads(ctx, limit)) out.push(await A.saveAndSend(ctx, await A.enrichItem(ctx, c))); return out; }
module.exports = { fakeWorld, mkCtx, msg, runIntake, runProcess, gem, A };
