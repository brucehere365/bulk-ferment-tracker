/* node sync.tests.js — the sync endpoint, run for real.
 *
 * This drives the actual Pages Function from functions/api/sync.js against a
 * fake KV namespace, using real Request/Response objects. No mocking of the
 * code under test: the merge here is the merge that will run on Cloudflare.
 *
 * It matters more than its size suggests. The endpoint is the one place where
 * two phones' bakes are reconciled, so a wrong merge silently loses a bake on
 * one of them — which is the exact failure the whole feature exists to stop. */
'use strict';

var pass = 0, fail = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}
function head(s) { console.log('\n' + s + '\n' + '-'.repeat(s.length)); }

function fakeKV() {
  var m = new Map();
  return {
    _map: m,
    get: function (k, type) {
      var v = m.get(k);
      return Promise.resolve(v == null ? null : (type === 'json' ? JSON.parse(v) : v));
    },
    put: function (k, v) { m.set(k, v); return Promise.resolve(); }
  };
}

function bake(id, name, readings) {
  return {
    id: id, name: name, startedAt: 1000, status: 'active',
    readings: Array.from({ length: readings }, function (_, i) {
      return { id: id + ':' + i, t: 1000 + i * 60000, temp: 24, rise: null, gapTemp: null };
    }),
    alerts: { lead: null, end: null }, crumb: '', finalCal: 1, useJar: true
  };
}

function post(mod, env, body, raw) {
  var text = raw != null ? raw : JSON.stringify(body);
  var req = new Request('https://loaf.test/api/sync', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: text
  });
  return mod.onRequestPost({ request: req, env: env });
}

(async function () {
  var mod = await import('./functions/api/sync.js');
  var CODE = 'two-loaves-one-oven';

  head('A FIRST PUSH');
  var env = { BAKES: fakeKV() };
  var res = await post(mod, env, { code: CODE, state: { bakes: [bake('a', 'Phone A bake', 2)], activeId: 'a' } });
  var body = await res.json();
  ok('is accepted', res.status === 200 && body.stored === true);
  ok('and comes back with the bake in it', body.state.bakes.length === 1 && body.state.bakes[0].id === 'a');
  ok('the running bake is preserved', body.state.activeId === 'a');

  head('THE SECOND PHONE GETS BOTH');
  res = await post(mod, env, { code: CODE, state: { bakes: [bake('b', 'Phone B bake', 1)], activeId: 'b' } });
  body = await res.json();
  var ids = body.state.bakes.map(function (x) { return x.id; }).sort();
  ok('the union of both phones comes back', ids.join(',') === 'a,b', ids.join(','));
  ok('and neither phone lost its own bake', ids.indexOf('a') >= 0 && ids.indexOf('b') >= 0);

  head('THE COPY THAT SAW MORE OF THE BAKE WINS');
  res = await post(mod, env, { code: CODE, state: { bakes: [bake('a', 'Phone A bake', 7)] } });
  body = await res.json();
  var a = body.state.bakes.filter(function (x) { return x.id === 'a'; })[0];
  ok('a longer history replaces a shorter one', a.readings.length === 7, String(a.readings.length));

  res = await post(mod, env, { code: CODE, state: { bakes: [bake('a', 'Phone A bake', 3)] } });
  body = await res.json();
  a = body.state.bakes.filter(function (x) { return x.id === 'a'; })[0];
  ok('and a shorter one never clobbers a longer one', a.readings.length === 7, String(a.readings.length));

  head('A DELETED BAKE STAYS DELETED');
  /* Without tombstones the other phone syncs it straight back, which reads as
   * a bug and teaches you not to trust the delete button. */
  res = await post(mod, env, { code: CODE, state: { bakes: [], deleted: { b: 123 } } });
  body = await res.json();
  ok('deleting on one phone removes it from the shared copy',
    body.state.bakes.filter(function (x) { return x.id === 'b'; }).length === 0);
  res = await post(mod, env, { code: CODE, state: { bakes: [bake('b', 'Phone B bake', 1)] } });
  body = await res.json();
  ok('and the other phone pushing it again does not resurrect it',
    body.state.bakes.filter(function (x) { return x.id === 'b'; }).length === 0,
    body.state.bakes.map(function (x) { return x.id; }).join(','));
  ok('the bakes that were not deleted are untouched',
    body.state.bakes.filter(function (x) { return x.id === 'a'; }).length === 1);

  head('AN ACTIVE BAKE THAT NO LONGER EXISTS IS NOT LEFT DANGLING');
  ok('activeId only survives if it names a live bake',
    body.state.activeId === null || body.state.bakes.some(function (x) { return x.id === body.state.activeId; }),
    String(body.state.activeId));

  head('KITCHEN CODES ARE ISOLATED');
  res = await post(mod, env, { code: 'a-completely-different-code', state: { bakes: [bake('z', 'Someone else', 1)] } });
  body = await res.json();
  ok('another code sees only its own bakes',
    body.state.bakes.length === 1 && body.state.bakes[0].id === 'z');
  res = await post(mod, env, { code: CODE, state: { bakes: [] } });
  body = await res.json();
  ok('and cannot see into the first', body.state.bakes.every(function (x) { return x.id !== 'z'; }));

  head('THE CODE ITSELF IS NEVER STORED');
  var keys = [].concat.apply([], Array.from(env.BAKES._map.keys()));
  ok('keys are hashes, not codes', keys.every(function (k) { return /^bakes:[0-9a-f]{64}$/.test(k); }), keys.join(' '));
  ok('and no stored value contains the code',
    Array.from(env.BAKES._map.values()).every(function (v) { return v.indexOf(CODE) < 0; }));

  head('WHAT IT REFUSES');
  res = await post(mod, env, { code: 'short', state: { bakes: [] } });
  ok('a code under 8 characters', res.status === 400 && (await res.json()).error === 'code-too-short');

  res = await post(mod, env, null, '{not json');
  ok('a body that is not JSON', res.status === 400);

  res = await post(mod, env, { code: CODE, state: { note: 'x'.repeat(1024 * 1024 + 10) } });
  ok('a payload over 1 MB', res.status === 413, String(res.status));

  res = await post(mod, {}, { code: CODE, state: { bakes: [] } });
  ok('and it says so plainly when KV is not bound yet',
    res.status === 503 && (await res.json()).error === 'sync-not-configured');

  res = await mod.onRequest();
  ok('a GET is refused rather than supported, so no code reaches a URL',
    res.status === 405);

  head('A KV WRITE FAILURE STILL HANDS BACK THE MERGE');
  /* The caller's own copy is safe on its own device either way, so failing to
   * store must not also mean failing to deliver the other phone's bakes. */
  var brokenEnv = { BAKES: { get: fakeKV().get, put: function () { return Promise.reject(new Error('KV down')); } } };
  res = await post(mod, brokenEnv, { code: CODE, state: { bakes: [bake('c', 'Offline-ish', 1)] } });
  body = await res.json();
  ok('the response is still a merge', res.status === 200 && body.state.bakes.length === 1);
  ok('and it admits it did not store', body.stored === false);

  head('SUMMARY');
  console.log((fail ? '  FAILED ' + fail + ' / ' + (pass + fail) + '\n   · ' + failures.join('\n   · ')
    : '  All ' + pass + ' sync assertions passed.'));
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
