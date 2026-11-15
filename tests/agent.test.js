const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { fakeWorld, mkCtx, msg, runIntake, runProcess, A } = require('./helpers.js');

test('intake: queues a valid command, replies, and commits the offset', async () => {
  const { ctx, world } = mkCtx();
  world.telegramUpdates.push(msg(10, 111, 'Find event leads for Acme in Gurgaon'));
  const replies = await runIntake(ctx);
  assert.equal(replies.length, 1); assert.match(replies[0].text, /Queued LD-0001: Acme \(Gurgaon\)/);
  const rows = await ctx.store.all(); assert.equal(rows[0].status, 'NEW'); assert.equal(rows[0].requested_by, '111');
  assert.equal(await ctx.store.getMeta('tg_offset'), 11);
  assert.equal((await runIntake(ctx)).length, 0, 'already-handled update is not re-delivered');
});

test('intake: unauthorised chat is refused and nothing is queued', async () => {
  const { ctx, world } = mkCtx();
  world.telegramUpdates.push(msg(1, 999, 'Find event leads for Acme in Gurgaon'));
  const [r] = await runIntake(ctx);
  assert.match(r.text, /private/); assert.equal((await ctx.store.all()).length, 0);
});

test('intake: duplicate within the window is not queued twice', async () => {
  const { ctx, world } = mkCtx();
  world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon'), msg(2, 111, 'find leads for ACME in gurgaon.'));
  const replies = await runIntake(ctx);
  assert.match(replies[1].text, /Already have this one \(LD-0001/);
  assert.equal((await ctx.store.all()).length, 1);
});

test('intake: gibberish gets help, not a row; LLM parse cannot invent values', async () => {
  const { ctx, world } = mkCtx();
  world.telegramUpdates.push(msg(1, 111, 'hello there'));
  assert.match((await runIntake(ctx))[0].text, /couldn't find a company and city/);
  world.llmParse = { company: 'Zomato', city: 'Mumbai' }; // not present in the message -> must be rejected
  world.telegramUpdates.push(msg(2, 111, 'please look into that food company'));
  assert.match((await runIntake(ctx))[0].text, /couldn't find/);
  assert.equal((await ctx.store.all()).length, 0);
});

test('intake: LLM parse rescues loosely-worded messages when values are in the text', async () => {
  const { ctx, world } = mkCtx();
  world.llmParse = { company: 'Acme', city: 'Gurgaon' };
  world.telegramUpdates.push(msg(1, 111, 'any people to talk to at Acme near Gurgaon for events?'));
  assert.match((await runIntake(ctx))[0].text, /Queued LD-0001: Acme \(Gurgaon\)/);
});

test('intake: /status and /help work', async () => {
  const { ctx, world } = mkCtx();
  world.telegramUpdates.push(msg(1, 111, '/help'), msg(2, 111, '/status'));
  const [h, s] = await runIntake(ctx);
  assert.match(h.text, /Find event leads/); assert.match(s.text, /No leads yet/);
});

test('process: full path to SENT, mail goes to the SANDBOX inbox, follow-up scheduled', async () => {
  const { ctx, world, dir } = mkCtx({ FOLLOWUP_DELAY_MINUTES: '5' });
  world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(ctx);
  const [r] = await runProcess(ctx);
  assert.equal(r.status, 'SENT'); assert.equal(r.chat_id, '111'); assert.match(r.text, /SANDBOX/);
  const mail = JSON.parse(fs.readFileSync(dir + '/outbox/dry-LD-0001__1.json', 'utf8'));
  assert.equal(mail.to, 'qa-inbox@gmail.com'); assert.match(mail.body, /\[SANDBOX\] Intended for: Priya Sharma/);
  assert.match(mail.body, /Reply "stop"/);
  const row = (await ctx.store.all())[0];
  assert.equal(row.status, 'SENT'); assert.ok(Date.parse(row.followup_due_at) > Date.now());
});

test('safety: never emails a real lead unless sandbox is off AND ALLOW_REAL_SEND=true', async () => {
  const a = mkCtx({ SANDBOX_MODE: 'false' }); // sandbox off but no explicit allow flag
  a.world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(a.ctx);
  await runProcess(a.ctx);
  assert.equal(JSON.parse(fs.readFileSync(a.dir + '/outbox/dry-LD-0001__1.json', 'utf8')).to, 'qa-inbox@gmail.com');
  const b = mkCtx({ SANDBOX_MODE: 'false', ALLOW_REAL_SEND: 'true' });
  b.world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(b.ctx);
  await runProcess(b.ctx);
  assert.equal(JSON.parse(fs.readFileSync(b.dir + '/outbox/dry-LD-0001__1.json', 'utf8')).to, 'events@acme.com');
});

test('safety: placeholder sandbox inbox is refused, lead stays READY_TO_SEND with an error', async () => {
  const { ctx, world } = mkCtx({ SANDBOX_INBOX: 'your.test.inbox@gmail.com' });
  world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(ctx);
  const [r] = await runProcess(ctx);
  assert.equal(r.status, 'READY_TO_SEND'); assert.match((await ctx.store.all())[0].error, /SANDBOX_INBOX/);
});

test('process: a send failure is retried on the next run without re-enriching', async () => {
  const { ctx, world } = mkCtx();
  world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(ctx);
  const realSend = ctx.mailer.send.bind(ctx.mailer); let fail = true;
  ctx.mailer.send = async (a) => { if (fail) throw new Error('gmail down'); return realSend(a); };
  await runProcess(ctx); assert.equal((await ctx.store.all())[0].status, 'READY_TO_SEND');
  fail = false; const before = world.calls.filter((c) => /tavily|generativelanguage/.test(c)).length;
  const [r] = await runProcess(ctx);
  assert.equal(r.status, 'SENT');
  assert.equal(world.calls.filter((c) => /tavily|generativelanguage/.test(c)).length, before, 'no extra Tavily/Gemini quota spent on resend');
});

test('process: NEEDS_REVIEW is not sent; human approval (status=READY_TO_SEND) sends it', async () => {
  const w = fakeWorld(); const orig = w.http;
  w.http = async (req) => (/r\.jina\.ai/.test(req.url) ? { status: 200, text: 'nothing here' } : (/dns\.google/.test(req.url) ? { status: 200, json: {} } : orig(req)));
  const { ctx } = mkCtx({}, w);
  await ctx.store.append({ company: 'Acme', city: 'Gurgaon', source: 'sheet' });
  const [r] = await runProcess(ctx);
  assert.equal(r.status, 'NEEDS_REVIEW'); assert.match(r.text, /set status to READY_TO_SEND/);
  await ctx.store.update('LD-0001', { status: 'READY_TO_SEND', email: 'priya@acme.com', email_source: 'website' });
  const [r2] = await runProcess(ctx); assert.equal(r2.status, 'SENT');
});

test('sheet-typed rows are adopted (id + status) and duplicates are marked', async () => {
  const { ctx } = mkCtx();
  await ctx.store.append({ company: 'Acme', city: 'Gurgaon' });
  await ctx.store.append({ company: 'acme', city: 'Gurgaon' });
  await runProcess(ctx, 5);
  const rows = await ctx.store.all();
  assert.equal(rows[0].request_id, 'LD-0001'); assert.equal(rows[0].status, 'SENT');
  assert.equal(rows[1].status, 'DUPLICATE'); assert.match(rows[1].notes, /Duplicate of LD-0001/);
});

test('recovery: stuck PROCESSING rows are reset, then FAILED after max attempts', async () => {
  const { ctx } = mkCtx();
  const old = new Date(Date.now() - 3600000).toISOString();
  await ctx.store.append({ request_id: 'LD-0001', company: 'A', city: 'X', status: 'PROCESSING', attempts: '1', updated_at: old });
  await ctx.store.append({ request_id: 'LD-0002', company: 'B', city: 'Y', status: 'PROCESSING', attempts: '3', updated_at: old });
  const d = JSON.parse(fs.readFileSync(ctx.store.file)); d.leads.forEach((r) => { r.updated_at = old; }); fs.writeFileSync(ctx.store.file, JSON.stringify(d));
  await A.claimLeads(ctx, 0);
  const rows = await ctx.store.all();
  assert.equal(rows[0].status, 'NEW'); assert.equal(rows[1].status, 'FAILED');
});

test('failure: search outage retries silently, then FAILED after max attempts', async () => {
  const w = fakeWorld(); const orig = w.http; w.http = async (req) => (/api\.tavily/.test(req.url) ? { status: 429, json: {} } : orig(req));
  const { ctx } = mkCtx({}, w);
  await ctx.store.append({ company: 'Acme', city: 'Gurgaon' });
  for (let i = 0; i < 3; i++) await runProcess(ctx);
  const row = (await ctx.store.all())[0];
  assert.equal(row.status, 'FAILED'); assert.match(row.error, /Search/);
});

test('follow-up: sent in the same thread when there is no reply', async () => {
  const { ctx, dir } = mkCtx();
  await ctx.store.append({ company: 'Acme', city: 'Gurgaon' }); await runProcess(ctx);
  const [d] = await A.dueFollowups(ctx); const r = await A.runFollowup(ctx, d);
  assert.equal(r.status, 'FOLLOWED_UP');
  const f = JSON.parse(fs.readFileSync(dir + '/outbox/dry-LD-0001__2.json', 'utf8'));
  assert.equal(f.threadId, 'dry-LD-0001'); assert.match(f.subject, /^Re: /);
  assert.equal((await A.dueFollowups(ctx)).length, 0, 'never followed up twice');
});

test('follow-up: a reply cancels it and marks REPLIED', async () => {
  const { ctx, dir } = mkCtx();
  await ctx.store.append({ company: 'Acme', city: 'Gurgaon' }); await runProcess(ctx);
  fs.mkdirSync(dir + '/replies', { recursive: true }); fs.writeFileSync(dir + '/replies/LD-0001', 'x');
  const [d] = await A.dueFollowups(ctx); const r = await A.runFollowup(ctx, d);
  assert.equal(r.status, 'REPLIED'); assert.equal((await ctx.store.all())[0].status, 'REPLIED');
  assert.equal(fs.readdirSync(dir + '/outbox').length, 1, 'no follow-up email was sent');
});

test('follow-up: if the reply check fails we do NOT follow up blindly', async () => {
  const { ctx, dir } = mkCtx();
  await ctx.store.append({ company: 'Acme', city: 'Gurgaon' }); await runProcess(ctx);
  ctx.mailer.hasReply = async () => { throw new Error('gmail 500'); };
  const [d] = await A.dueFollowups(ctx); const r = await A.runFollowup(ctx, d);
  assert.equal(r.status, 'SENT'); assert.equal(fs.readdirSync(dir + '/outbox').length, 1);
});

test('overlap: two runs started back to back never claim the same lead', async () => {
  const { ctx } = mkCtx();
  for (const c of ['A', 'B', 'C', 'D']) await ctx.store.append({ company: c + ' Co', city: 'Pune' });
  const [r1, r2] = await Promise.all([A.claimLeads(ctx, 2), (async () => { await new Promise((r) => setTimeout(r, 0)); return A.claimLeads(ctx, 2); })()]);
  const ids = [...r1, ...r2].map((x) => x.request_id);
  assert.equal(new Set(ids).size, ids.length, 'a lead was claimed twice: ' + ids);
});

// ---------------------------------------------------------------- human approval gate
const approvalCtx = () => mkCtx({ REQUIRE_APPROVAL: '' }); // unset = default = approval required

test('approval: a finished draft is NOT sent; it waits in AWAITING_APPROVAL with instructions', async () => {
  const { ctx, world } = approvalCtx();
  world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(ctx);
  const [r] = await runProcess(ctx);
  assert.equal(r.status, 'AWAITING_APPROVAL'); assert.match(r.text, /NOT SENT/); assert.match(r.text, /approve LD-0001/);
  assert.equal(fs.existsSync(ctx.store.dir + '/outbox') && fs.readdirSync(ctx.store.dir + '/outbox').length, false, 'nothing in the outbox');
  assert.equal((await runProcess(ctx)).length, 0, 'a later run does not send it either');
  assert.equal((await ctx.store.all())[0].status, 'AWAITING_APPROVAL');
});

test('approval: "approve LD-0001" from an allowed chat sends it, then follow-up proceeds as usual', async () => {
  const { ctx, world } = approvalCtx();
  world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(ctx);
  await runProcess(ctx);
  world.telegramUpdates.push(msg(2, 111, 'approve ld-0001'));
  assert.match((await runIntake(ctx))[0].text, /approved/);
  assert.equal((await ctx.store.all())[0].status, 'READY_TO_SEND');
  const [r] = await runProcess(ctx);
  assert.equal(r.status, 'SENT'); assert.equal(world.calls.filter((c) => /tavily|generativelanguage/.test(c)).length > 0, true);
});

test('approval: reject sends nothing and cannot be approved afterwards', async () => {
  const { ctx, world } = approvalCtx();
  world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(ctx); await runProcess(ctx);
  world.telegramUpdates.push(msg(2, 111, '/reject LD-0001'), msg(3, 111, 'approve LD-0001'));
  const [a, b] = await runIntake(ctx);
  assert.match(a.text, /rejected/); assert.match(b.text, /not waiting for approval/);
  assert.equal((await ctx.store.all())[0].status, 'REJECTED'); assert.equal((await runProcess(ctx)).length, 0);
});

test('approval: only allow-listed chats can approve; unknown ids and non-waiting leads change nothing', async () => {
  const { ctx, world } = approvalCtx();
  world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(ctx); await runProcess(ctx);
  world.telegramUpdates.push(msg(2, 999, 'approve LD-0001'), msg(3, 111, 'approve LD-0099'), msg(4, 111, 'approve'));
  const [x, y, z] = await runIntake(ctx);
  assert.match(x.text, /private/); assert.match(y.text, /No lead LD-0099/); assert.match(z.text, /Say which lead/);
  assert.equal((await ctx.store.all())[0].status, 'AWAITING_APPROVAL');
});

test('approval: fails closed (only an explicit false/no/off/0 disables it)', async () => {
  for (const [v, want] of [['', true], ['true', true], ['garbage', true], ['false', false], ['No', false], ['off', false]]) {
    assert.equal(A.needsApproval({ require_approval: v === '' ? undefined : v }), want, 'value ' + JSON.stringify(v));
  }
});

// ---------------------------------------------------------------- approval buttons
const T = require('../src/telegram.js');
const tap = (id, chat, data, msgId = 77) => ({ update_id: id, callback_query: { id: 'cb' + id, data, message: { message_id: msgId, chat: { id: +chat, type: 'private' } } } });

test('buttons: the awaiting-approval card carries Approve and Reject buttons, other cards do not', async () => {
  const { ctx, world } = approvalCtx();
  world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(ctx);
  const [r] = await runProcess(ctx);
  assert.deepEqual(r.buttons[0].map((b) => b.callback_data), ['approve:LD-0001', 'reject:LD-0001']);
  await T.deliver(ctx, r);
  const sent = world.telegramSent.at(-1); assert.equal(sent.reply_markup.inline_keyboard[0].length, 2);
  const w2 = approvalCtx(); w2.world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(w2.ctx);
  await runProcess(w2.ctx); const rep = await runIntake(w2.ctx); assert.equal(rep.length, 0);
});

test('buttons: tapping Approve approves, answers the tap and removes the buttons', async () => {
  const { ctx, world } = approvalCtx();
  world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(ctx); await runProcess(ctx);
  world.telegramUpdates.push(tap(2, 111, 'approve:LD-0001'));
  const [rep] = await runIntake(ctx);
  assert.match(rep.text, /approved/); assert.equal(rep.callback_id, 'cb2');
  await T.deliver(ctx, rep);
  assert.deepEqual(world.telegramCalls.map((c) => c[0]), ['answerCallbackQuery', 'editMessageReplyMarkup']);
  assert.deepEqual(world.telegramCalls[1][1].reply_markup, { inline_keyboard: [] });
  assert.equal((await ctx.store.all())[0].status, 'READY_TO_SEND');
});

test('buttons: Reject works, and a tap from an unauthorised chat changes nothing', async () => {
  const { ctx, world } = approvalCtx();
  world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(ctx); await runProcess(ctx);
  world.telegramUpdates.push(tap(2, 999, 'approve:LD-0001'), tap(3, 111, 'reject:LD-0001'));
  const [bad, ok] = await runIntake(ctx);
  assert.match(bad.text, /private/); assert.match(ok.text, /rejected/);
  assert.equal((await ctx.store.all())[0].status, 'REJECTED');
});

test('buttons: a double tap is harmless (second one reports not waiting)', async () => {
  const { ctx, world } = approvalCtx();
  world.telegramUpdates.push(msg(1, 111, 'Find event leads for Acme in Gurgaon')); await runIntake(ctx); await runProcess(ctx);
  world.telegramUpdates.push(tap(2, 111, 'approve:LD-0001'), tap(3, 111, 'approve:LD-0001'));
  const [a, b] = await runIntake(ctx);
  assert.match(a.text, /approved/); assert.match(b.text, /not waiting for approval/);
});
