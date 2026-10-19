'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { listPool, choose } = require('../app/core/select');

// Pool entries don't need real dirs for choose(); shape matters only.
const P = (version, chromiumMajor) => ({
  version, path: `/runtimes/nwjs-v${version}-linux-x64`, source: 'bundled', node: 'x', chromiumMajor,
});

test('choose: exact match of a legacy detection is skipped — falls forward to the usable floor', () => {
  const pool = [P('0.12.3', 27), P('0.29.0', 65), P('0.48.4', 85), P('0.115.0', 152)];
  const r = choose(pool, '0.29.0', 'MV', '1.6.1');
  assert.equal(r.runtime.version, '0.48.4');
  assert.equal(r.refused, null);
  assert.ok(r.notes.some(n => /0\.29\.0.*floor.*0\.48\.4|floor.*0\.29\.0/i.test(n)));
  assert.ok(!r.notes.some(n => /exact match/i.test(n)));
});

test('choose: all-legacy pool refuses with import guidance', () => {
  const r = choose([P('0.12.3', 27), P('0.29.0', 65)], '0.29.0', 'MV', '1.6.1');
  assert.equal(r.runtime, null);
  assert.ok(r.refused.match(/0\.48\.4/));
});

test('choose: nearest newer when exact missing; jumps get plugin warning', () => {
  const pool = [P('0.12.3', 27), P('0.48.4', 85), P('0.115.0', 152)];
  const r = choose(pool, '0.29.0', 'MV', '1.6.1');       // detected 0.29 (C65) → 0.48.4 (C85): +20
  assert.equal(r.runtime.version, '0.48.4');
  assert.ok(r.warnings.some(w => /plugin/i.test(w)));
});

test('choose: MZ floor refuses below 0.44 (override can reach it); all-legacy pool refuses on usability floor', () => {
  const old = [P('0.12.3', 27), P('0.29.0', 65)];
  assert.ok(choose(old, '0.30.0', 'MZ', '1.0.0').refused.match(/0\.48\.4/));   // usable floor fires first
  assert.ok(choose(old, '0.30.0', 'MZ', '1.0.0', '0.29.0').refused.match(/0\.44/)); // override bypasses it, MZ floor remains
  const modern = [P('0.29.0', 65), P('0.48.4', 85)];
  assert.ok(choose(modern, '0.30.0', 'MZ', '1.0.0').refused === null);         // nearest-newer rescues sub-floor detection
  assert.equal(choose(modern, '0.30.0', 'MZ', '1.0.0').runtime.version, '0.48.4');
});

test('choose: MV <1.6.0 autoplay warning on modern chromium; old-runtime note only via override; empty pool refused', () => {
  const pool = [P('0.48.4', 85)];
  assert.ok(choose(pool, '0.19.5', 'MV', '1.3.0').warnings.some(w => /autoplay|BGM/i.test(w)));
  assert.ok(choose(pool, '0.19.5', 'MV', '1.3.0').warnings.some(w => /plugin/i.test(w)));
  const old = [P('0.29.0', 65)];
  assert.ok(choose(old, '0.19.5', 'MV', '1.5.0', '0.29.0').warnings.some(w => /old runtime|glibc|fontconfig/i.test(w)));
  assert.ok(choose([], '0.29.0', 'MV', '1.6.1').refused);
});

test('choose: downgrade note+warning when nothing in pool is ≥ detection', () => {
  const pool = [P('0.29.0', 65), P('0.48.4', 85)];
  const r = choose(pool, '0.60.0', 'MV', '1.6.1');
  assert.equal(r.runtime.version, '0.48.4');
  assert.ok(r.notes.some(n => /DOWNGRAD/i.test(n)));
  assert.ok(r.warnings.some(w => /downgrade/i.test(w)));
});

test('choose: override picks named runtime from pool', () => {
  const pool = [P('0.29.0', 65), P('0.48.4', 85)];
  assert.equal(choose(pool, '0.29.0', 'MV', '1.6.1', '0.48.4').runtime.version, '0.48.4');
  assert.ok(choose(pool, '0.29.0', 'MV', '1.6.1', '9.9.9').refused);
});

test('listPool admits the real dev ladder', { skip: !fs.existsSync('runtimes') }, () => {
  const { pool, rejected } = listPool(process.cwd());   // dev repo root acts as bundle
  const versions = pool.map(p => p.version);
  for (const v of ['0.12.3', '0.19.5', '0.22.3', '0.29.0', '0.48.4', pool.find(p => p.source === 'host').version])
    assert.ok(versions.includes(v), `missing ${v}`);
  assert.equal(rejected.length, 0);
});
