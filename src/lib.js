// Pure helpers shared by all workflows. No n8n or network dependencies, so they are unit-testable.
// scripts/build_workflows.py inlines this file into every n8n Code node that needs it.

const GENERIC_LOCALPARTS = ['info', 'hello', 'contact', 'support', 'hr', 'careers', 'jobs', 'events',
  'event', 'marketing', 'sales', 'admin', 'team', 'partnerships', 'people', 'office', 'enquiry', 'enquiries'];

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

// "Find event leads for Zomato in Gurgaon", "/lead Zomato, Gurgaon", "Zomato | Gurgaon"
function parseCommand(text) {
  const t = clean(text).replace(/^\/lead(@\w+)?\s*/i, 'find leads for ');
  let m = t.match(/^find\s+(?:\w+\s+)?leads?\s+for\s+(.+?)\s+in\s+(.+)$/i);
  if (m) return finish(m[1], m[2]);
  m = t.match(/^find\s+leads?\s+for\s+(.+?)\s*[,|\-–]\s*(.+)$/i);
  if (m) return finish(m[1], m[2]);
  m = t.match(/^(.+?)\s*[,|]\s*(.+)$/);
  if (m && !/^\//.test(t)) return finish(m[1], m[2]);
  return null;
}
function finish(company, city) {
  company = clean(company).replace(/^["'“”]+|["'“”.]+$/g, '');
  city = clean(city).replace(/^["'“”]+|["'“”.!?]+$/g, '');
  if (company.length < 2 || city.length < 2 || company.length > 80 || city.length > 60) return null;
  return { company, city };
}

function dedupeKey(company, city) {
  const n = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return n(company) + '|' + n(city);
}

// Regex host parser: n8n's Code sandbox has no global URL class.
function domainOf(url) {
  const m = /^(?:[a-z][a-z0-9+.\-]*:\/\/)?(?:[^\/?#@]*@)?([a-z0-9](?:[a-z0-9\-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?)+)(?::\d+)?(?:[\/?#]|$)/i.exec(String(url || '').trim());
  return m ? m[1].replace(/^www\./i, '').toLowerCase() : '';
}

// "careers.zomato.com" -> "zomato.com"; "shop.foo.co.in" -> "foo.co.in"
function registrable(domain) {
  const p = String(domain || '').toLowerCase().split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  const sld = /^(co|com|org|net|gov|edu|ac)$/.test(p[p.length - 2]) && p[p.length - 1].length === 2;
  return p.slice(sld ? -3 : -2).join('.');
}

// Domains that are never a company's own site (matched on the registrable suffix, so box.com != x.com).
const THIRD_PARTY = ['linkedin.com','facebook.com','instagram.com','twitter.com','x.com','youtube.com','wikipedia.org',
  'crunchbase.com','glassdoor.com','glassdoor.co.in','ambitionbox.com','naukri.com','indeed.com','justdial.com','zaubacorp.com',
  'tofler.in','bloomberg.com','reuters.com','economictimes.indiatimes.com','medium.com','quora.com','reddit.com',
  'tripadvisor.com','yelp.com','pinterest.com','tavily.com','zoominfo.com','rocketreach.co','apollo.io','lusha.com',
  'signalhire.com','tracxn.com','owler.com','dnb.com','linktr.ee','github.com','wellfound.com','ycombinator.com'];
function isThirdParty(domain) {
  const d = String(domain || '').toLowerCase();
  return THIRD_PARTY.some((t) => d === t || d.endsWith('.' + t));
}

function extractEmails(text) {
  const found = String(text || '').match(/[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)+/gi) || [];
  return [...new Set(found.map((e) => e.toLowerCase()))]
    .filter((e) => !/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e) && !/(sentry|example|wixpress|your-?email|domain\.com)/.test(e));
}
function isGenericInbox(email) {
  return GENERIC_LOCALPARTS.includes(String(email).split('@')[0].toLowerCase());
}

function guessEmails(fullName, domain) {
  const parts = clean(fullName).toLowerCase().replace(/[^a-z\s]/g, '').split(' ').filter(Boolean);
  if (parts.length < 2 || !domain) return [];
  const f = parts[0], l = parts[parts.length - 1];
  return [`${f}.${l}@${domain}`, `${f}@${domain}`, `${f}${l}@${domain}`, `${f[0]}${l}@${domain}`];
}

// Higher = better target. Startups want the founder; big companies want events/people teams.
function roleScore(title, companySize) {
  const t = clean(title).toLowerCase();
  const big = companySize === 'large';
  const rules = [
    [/event|experience|engagement|culture|offsite|celebration/, big ? 100 : 80],
    [/founder|co-?founder|ceo|owner|managing director|\bmd\b|proprietor/, big ? 40 : 100],
    [/hr|human resources|people|talent|admin/, big ? 85 : 70],
    [/marketing|brand|community|partnership/, 50],
    [/head|director|vp|vice president|chief|manager|lead/, 30],
  ];
  let best = 0;
  for (const [re, s] of rules) if (re.test(t)) best = Math.max(best, s);
  return best;
}

// Anti-hallucination gate: a candidate survives only if it cites a source URL
// and (when it carries an email) that email was seen in a source or is explicitly labelled guessed.
function validateCandidate(c) {
  const errors = [];
  if (!c || typeof c !== 'object') return { ok: false, errors: ['not an object'] };
  if (!clean(c.name)) errors.push('missing name');
  if (!clean(c.title)) errors.push('missing title');
  if (!/^https?:\/\//i.test(clean(c.source_url))) errors.push('missing source_url');
  if (c.email && !['hunter', 'website', 'guessed', 'role_inbox'].includes(c.email_source)) errors.push('bad email_source');
  if (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) errors.push('bad email format');
  return { ok: errors.length === 0, errors };
}

function validatePitch(p, company) {
  const errors = [];
  if (!p || typeof p !== 'object') return { ok: false, errors: ['not an object'] };
  const subject = clean(p.subject);
  const lines = Array.isArray(p.pitch_lines) ? p.pitch_lines.map(clean).filter(Boolean) : [];
  if (!subject || subject.length > 90) errors.push('subject missing or >90 chars');
  if (lines.length !== 3) errors.push('pitch must be exactly 3 lines, got ' + lines.length);
  if (lines.some((l) => l.length > 220)) errors.push('a pitch line is >220 chars');
  const all = lines.join(' ') + ' ' + subject + ' ' + clean(p.followup);
  if (/\[[^\]]+\]|\{\{|<name>|lorem/i.test(all)) errors.push('placeholder text left in output');
  if (!all.toLowerCase().includes(clean(company).toLowerCase().split(' ')[0])) errors.push('does not mention the company');
  if (!clean(p.followup) || clean(p.followup).length > 400) errors.push('followup missing or too long');
  return { ok: errors.length === 0, errors };
}

// Last-resort deterministic pitch so the pipeline never stalls on the LLM.
function templatePitch(company, city, contact, senderName) {
  const first = clean(contact && contact.name).split(' ')[0] || 'there';
  const sender = clean(senderName) || 'the GoPratle team';
  return {
    subject: `Vetted planners, DJs & crew for ${company}'s events`,
    pitch_lines: [
      `Hi ${first}, GoPratle connects event hosts with vetted planners, DJs and crew.`,
      `If ${company} in ${city} runs events, offsites or celebrations, we can shortlist trusted professionals fast.`,
      `Open to a quick 10-minute chat this week?`,
    ],
    followup: `Hi ${first}, just following up on my note about GoPratle - happy to share a few vetted planner and DJ profiles for ${company} if useful. - ${sender}`,
    generated_by: 'template',
  };
}

// Wrap untrusted web text so the model treats it as data, and cap its size.
function asData(label, text, max) {
  const body = clean(text).replace(/<\/?data[^>]*>/gi, '').slice(0, max || 4000);
  return `<data source="${label}">\n${body}\n</data>`;
}

// Gemini sometimes wraps JSON in ```json fences.
function parseJsonLoose(s) {
  if (s && typeof s === 'object') return s;
  const t = String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch (e) {}
  const m = t.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

const api = { clean, parseCommand, dedupeKey, domainOf, registrable, THIRD_PARTY, isThirdParty, extractEmails, isGenericInbox, guessEmails,
  roleScore, validateCandidate, validatePitch, templatePitch, asData, parseJsonLoose };
if (typeof module !== 'undefined') module.exports = api;
