#!/usr/bin/env node
// Run the exact functions the n8n workflows run, from the terminal (no n8n needed).
//   node scripts/run_local.js tick                 poll Telegram, process the queue, send due follow-ups
//   node scripts/run_local.js add "Zomato" "Gurgaon"   add a row as if typed into the Sheet
//   node scripts/run_local.js reply LD-0001        simulate the lead replying (dry-run mailer)
//   node scripts/run_local.js status | poll | process | followups
const { loadEnv, http, fs } = require('./lib_env.js');
const A = require('../src/agent.js');
const T = require('../src/telegram.js');

(async () => {
  const env = loadEnv();
  env.DATA_DIR = env.DATA_DIR_HOST || './n8n_data/bdr';
  const ctx = A.makeCtx({ http, env, fs, crypto: require('crypto') });
  const [cmd, ...args] = process.argv.slice(2);
  const send = async (rs) => { for (const r of rs) { if (r && r.chat_id && r.text) { console.log(`-> telegram ${r.chat_id}: ${r.text.split('\n')[0]}`); await T.sendMessage(ctx, r.chat_id, r.text); } } };
  const poll = async () => { const items = await A.pollTelegram(ctx); console.log('telegram updates:', items.length); await send(await A.handleMessages(ctx, items)); };
  const proc = async () => { const claimed = await A.claimLeads(ctx, 2); console.log('claimed:', claimed.map((c) => c.request_id).join(', ') || 'none'); for (const c of claimed) { const e = await A.enrichItem(ctx, c); const r = await A.saveAndSend(ctx, e); console.log(`${c.request_id} -> ${r.status}`); await send([r]); } };
  const fup = async () => { const due = await A.dueFollowups(ctx, 5); console.log('followups due:', due.length); for (const d of due) { const r = await A.runFollowup(ctx, d); console.log(`${d.request_id} -> ${r.status}`); await send([r]); } };
  if (cmd === 'poll') await poll();
  else if (cmd === 'process') await proc();
  else if (cmd === 'followups') await fup();
  else if (cmd === 'tick') { await poll(); await proc(); await fup(); }
  else if (cmd === 'status') console.log(await A.statusReply(ctx, args[0]));
  else if (cmd === 'add') { await A.loadConfig(ctx); const id = await ctx.store.nextId(); await ctx.store.append({ company: args[0], city: args[1], source: 'sheet' }); console.log('added row (no id yet; the processor adopts it):', args[0], args[1]); }
  else if (cmd === 'reply') { fs.mkdirSync(env.DATA_DIR + '/replies', { recursive: true }); fs.writeFileSync(`${env.DATA_DIR}/replies/${args[0]}`, 'reply'); console.log('simulated reply for', args[0]); }
  else { console.log('commands: tick | poll | process | followups | status [id] | add "<company>" "<city>" | reply <id>'); }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
