// n8n runs Code nodes in a restricted sandbox (no URL, URLSearchParams or fetch). This runs the
// shared modules in a vm context that hides those globals, so such a dependency fails here first.
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadInSandbox(name) {
  const sandbox = { Buffer, TextEncoder, setTimeout, Promise, JSON, Math, Date, console, Array, Object, String, Number, RegExp, Set, Map, Error };
  const mods = {};
  const req = (n) => { const k = n.replace(/^\.\//, '').replace(/\.js$/, ''); if (mods[k]) return mods[k]; if (n === 'crypto' || n === 'fs') return require(n); throw new Error('unexpected require ' + n); };
  for (const m of ['lib', 'pipeline', 'telegram', 'store', 'mailer', 'agent']) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'src', m + '.js'), 'utf8');
    const module = { exports: {} };
    vm.runInNewContext(`(function (module, require) {${code}\n})`, sandbox)(module, req);
    mods[m] = module.exports;
  }
  return mods[name];
}

test('sandbox really lacks URL/fetch (guards this test itself)', () => {
  assert.equal(vm.runInNewContext('typeof URL + typeof fetch + typeof URLSearchParams', {}), 'undefinedundefinedundefined');
});
test('all modules load and domain parsing works without URL', () => {
  const lib = loadInSandbox('lib');
  assert.equal(lib.domainOf('https://www.razorpay.com/pricing?x=1'), 'razorpay.com');
  assert.equal(lib.domainOf('http://user:pw@careers.zomato.com:8080/a'), 'careers.zomato.com');
  assert.equal(lib.domainOf('razorpay.com'), 'razorpay.com');
  assert.equal(lib.domainOf('https://in.linkedin.com/in/x'), 'in.linkedin.com');
  assert.equal(lib.domainOf('not a url'), '');
  assert.equal(lib.domainOf(''), '');
  assert.equal(lib.registrable(lib.domainOf('https://shop.foo.co.in/x')), 'foo.co.in');
});
test('agent and pipeline load in the sandbox', () => {
  assert.equal(typeof loadInSandbox('agent').makeCtx, 'function');
  assert.equal(typeof loadInSandbox('pipeline').enrichLead, 'function');
});
