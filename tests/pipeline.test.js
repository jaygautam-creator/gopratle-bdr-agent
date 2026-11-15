const assert = require('node:assert/strict');
const test = require('node:test');
const { enrichLead } = require('../src/pipeline.js');

// Fake network: each scenario overrides only what it needs.
function makeCtx(over = {}) {
  const handlers = {
    tavily: (req) => {
      const q = req.body.query;
      if (/official website/.test(q)) return { status: 200, json: { answer: 'Acme makes anvils.', results: [{ title: 'Acme', url: 'https://www.acme.com/', content: 'Acme anvils' }] } };
      return { status: 200, json: { results: [{ title: 'Priya Sharma - Head of Events - Acme | LinkedIn', url: 'https://in.linkedin.com/in/priya-sharma', content: 'Priya Sharma Head of Events at Acme, Gurgaon' }] } };
    },
    gemini: (req) => {
      const prompt = req.body.contents[0].parts[0].text;
      if (/extract sales contacts/.test(prompt)) return gem({ company_size: 'large', company_summary: 'Acme makes anvils.', candidates: [{ name: 'Priya Sharma', title: 'Head of Events', source_url: 'https://in.linkedin.com/in/priya-sharma', linkedin_url: 'https://in.linkedin.com/in/priya-sharma' }] });
      return gem({ subject: 'Event crew for Acme', pitch_lines: ['Hi Priya, Acme runs events.', 'GoPratle connects hosts with vetted planners and DJs.', 'Open to a 10-minute chat?'], followup: 'Following up on Acme events.' });
    },
    dns: () => ({ status: 200, json: { Answer: [{ data: '10 mx.acme.com.' }] } }),
    jina: () => ({ status: 200, text: 'Contact us at events@acme.com' }),
    ...over,
  };
  const gem = (obj) => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } });
  const http = async (req) => {
    if (/tavily/.test(req.url)) return handlers.tavily(req);
    if (/generativelanguage/.test(req.url)) return handlers.gemini(req);
    if (/dns\.google/.test(req.url)) return handlers.dns(req);
    if (/r\.jina\.ai/.test(req.url)) return handlers.jina(req);
    return { status: 404, text: '' };
  };
  return { http, sleep: async () => {}, log: [], config: { min_confidence: 0.6, sender_name: 'Jay' },
    env: { TAVILY_API_KEY: 't', GEMINI_API_KEY: 'g', GEMINI_MODEL_PRIMARY: 'm1', GEMINI_MODEL_FALLBACK: 'm2' } };
}

test('happy path: grounded contact, website role inbox, READY_TO_SEND', async () => {
  const { lead } = await enrichLead(makeCtx(), { company: 'Acme', city: 'Gurgaon' });
  assert.equal(lead.status, 'READY_TO_SEND');
  assert.equal(lead.domain, 'acme.com');
  assert.equal(lead.lead_name, 'Priya Sharma');
  assert.equal(lead.email, 'events@acme.com');
  assert.equal(lead.email_source, 'role_inbox');
  assert.equal(lead.pitch.split('\n').length, 3);
});

test('hallucinated person (not in snippets) is dropped', async () => {
  const ctx = makeCtx({ gemini: (req) => /extract sales contacts/.test(req.body.contents[0].parts[0].text)
    ? { status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ candidates: [{ name: 'Rahul Verma', title: 'Founder', source_url: 'https://in.linkedin.com/in/priya-sharma' }] }) }] } }] } }
    : { status: 500 } });
  const { lead } = await enrichLead(ctx, { company: 'Acme', city: 'Gurgaon' });
  assert.equal(lead.lead_name, '');
  assert.notEqual(lead.status, 'READY_TO_SEND');
});

test('Gemini returning an array-wrapped object still works', async () => {
  const wrapped = makeCtx();
  const orig = wrapped.http;
  wrapped.http = async (req) => { const r = await orig(req); if (/generativelanguage/.test(req.url)) { const t = r.json.candidates[0].content.parts[0].text; r.json.candidates[0].content.parts[0].text = '[' + t + ']'; } return r; };
  const { lead } = await enrichLead(wrapped, { company: 'Acme', city: 'Gurgaon' });
  assert.equal(lead.lead_name, 'Priya Sharma');
});

test('both search providers down -> FAILED with a clear error, no crash', async () => {
  const ctx = makeCtx({ tavily: () => ({ status: 429, json: {} }) });
  const { lead } = await enrichLead(ctx, { company: 'Acme', city: 'Gurgaon' });
  assert.equal(lead.status, 'FAILED');
  assert.match(lead.error, /Search/);
});

test('Gemini fully down -> template pitch, pipeline still completes', async () => {
  const ctx = makeCtx({ gemini: () => ({ status: 503, json: {} }) });
  const { lead } = await enrichLead(ctx, { company: 'Acme', city: 'Gurgaon' });
  assert.ok(lead.pitch.split('\n').length === 3);
  assert.match(lead.notes, /template pitch/);
  assert.notEqual(lead.status, 'READY_TO_SEND'); // no verified contact without the LLM
});

test('Gemini 429 on primary falls through to the fallback model', async () => {
  const seen = [];
  const ctx = makeCtx();
  const orig = ctx.http;
  ctx.http = async (req) => { if (/generativelanguage/.test(req.url)) { seen.push(req.url.match(/models\/([^:]+)/)[1]); if (/models\/m1:/.test(req.url)) return { status: 429, json: {} }; } return orig(req); };
  const { lead } = await enrichLead(ctx, { company: 'Acme', city: 'Gurgaon' });
  assert.ok(seen.includes('m2'));
  assert.equal(lead.lead_name, 'Priya Sharma');
});

test('weak domain match + nobody found -> NOT_FOUND', async () => {
  const ctx = makeCtx({
    tavily: (req) => /official website/.test(req.body.query)
      ? { status: 200, json: { results: [{ title: 'Random Ventures', url: 'https://randomventures.com', content: 'x' }] } }
      : { status: 200, json: { results: [] } },
    gemini: () => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: '{"candidates":[]}' }] } }] } }),
  });
  const { lead } = await enrichLead(ctx, { company: 'Xqzvbnm Holdings', city: 'Pune' });
  assert.equal(lead.status, 'NOT_FOUND');
});

test('generic exec (not events/HR/founder) is not chosen as the contact', async () => {
  const ctx = makeCtx({ gemini: (req) => /extract sales contacts/.test(req.body.contents[0].parts[0].text)
    ? { status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ company_size: 'large', candidates: [{ name: 'Priya Sharma', title: 'Head - Business Development', source_url: 'https://in.linkedin.com/in/priya-sharma' }] }) }] } }] } }
    : { status: 500 } });
  const { lead } = await enrichLead(ctx, { company: 'Acme', city: 'Gurgaon' });
  assert.equal(lead.lead_name, '');
});

test('resolve: retries without the city when only aggregator pages come back first', async () => {
  let n = 0;
  const ctx = makeCtx({ tavily: (req) => {
    if (/official (website|site)/.test(req.body.query)) {
      n++; assert.ok(Array.isArray(req.body.exclude_domains) && req.body.exclude_domains.includes('linkedin.com'), 'third-party domains are excluded up front');
      return /official site/.test(req.body.query)
        ? { status: 200, json: { results: [{ title: 'Acme', url: 'https://www.acme.com/', content: 'anvils' }] } }
        : { status: 200, json: { results: [{ title: 'x', url: 'https://www.crunchbase.com/acme', content: '' }] } };
    }
    return { status: 200, json: { results: [{ title: 'Priya Sharma - Head of Events - Acme | LinkedIn', url: 'https://in.linkedin.com/in/priya-sharma', content: 'Priya Sharma Head of Events at Acme' }] } };
  } });
  const { lead } = await enrichLead(ctx, { company: 'Acme', city: 'Gurgaon' });
  assert.equal(n, 2); assert.equal(lead.domain, 'acme.com');
});

test('search: Serper takes over when Tavily is down', async () => {
  const ctx = makeCtx({ tavily: () => ({ status: 500, json: {} }) });
  ctx.env.SERPER_API_KEY = 's';
  const orig = ctx.http;
  ctx.http = async (req) => {
    if (/serper\.dev/.test(req.url)) {
      return /official/.test(req.body.q)
        ? { status: 200, json: { organic: [{ title: 'Acme', link: 'https://www.acme.com/', snippet: 'anvils' }] } }
        : { status: 200, json: { organic: [{ title: 'Priya Sharma - Head of Events - Acme | LinkedIn', link: 'https://in.linkedin.com/in/priya-sharma', snippet: 'Priya Sharma Head of Events at Acme' }] } };
    }
    return orig(req);
  };
  const { lead } = await enrichLead(ctx, { company: 'Acme', city: 'Gurgaon' });
  assert.equal(lead.domain, 'acme.com'); assert.equal(lead.lead_name, 'Priya Sharma');
});
