'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { analyzeInput, PortQueue, selftest } = require('../app/core/engine');
const { fixtureDirs } = require('./helpers/fixtures');

const SZ = path.join(__dirname, '..', 'bin', '7zz');

test('analyzeInput on fixture folders yields engine cards', { skip: fixtureDirs().length === 0 }, async () => {
  for (const d of fixtureDirs()) {
    const { cards } = await analyzeInput(d, { sevenZip: SZ });
    assert.equal(cards.length, 1);
    const c = cards[0];
    assert.equal(c.source, 'folder');
    assert.ok(c.info.engine === 'MV' || c.info.engine === 'MZ');
    assert.ok(c.info.detectedNW);
  }
});

test('analyzeInput rejects split/unknown inputs gracefully', async () => {
  const r = await analyzeInput('/tmp/kilo/whatever.zip.001', { sevenZip: SZ });
  assert.ok(r.cards[0].warnings.some(w => /split/i.test(w)) || r.cards[0].error);
  const r2 = await analyzeInput('/nonexistent/dir', { sevenZip: SZ });
  assert.ok(r2.cards.length === 0 || r2.cards[0].error);
});

test('PortQueue serializes; per-job cancel drops queued job', async () => {
  const q = new PortQueue();
  const order = [];
  const j1 = q.enqueue(() => new Promise(r => setTimeout(() => { order.push(1); r('a'); }, 30)));
  const j2 = q.enqueue(() => new Promise(r => setTimeout(() => { order.push(2); r('b'); }, 5)));
  assert.deepEqual(await Promise.all([j1.promise, j2.promise]), ['a', 'b']);
  assert.deepEqual(order, [1, 2]);               // serialized despite differing delays
  const q2 = new PortQueue();
  q2.enqueue(() => new Promise(r => setTimeout(r, 50)));
  const late = q2.enqueue(() => { throw new Error('should not run'); });
  late.token.cancelled = true;                   // per-job cancel while queued
  await late.promise.then(() => assert.fail('should reject'), e => assert.match(e.message, /cancel/i));
});

test('PortQueue: a failed job does not poison the chain', async () => {
  const q = new PortQueue();
  const bad = q.enqueue(() => Promise.reject(new Error('boom')));
  const good = q.enqueue(() => Promise.resolve('ok'));
  await bad.promise.then(() => assert.fail('should reject'), e => assert.match(e.message, /boom/));
  assert.equal(await good.promise, 'ok');
});

test('selftest passes on dev layout', { skip: !fs.existsSync(SZ) }, async () => {
  const r = await selftest(process.cwd());
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter(c => !c.ok)));
});
