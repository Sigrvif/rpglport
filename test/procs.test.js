'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const { descendantCmdline, parseDiag } = require('../app/core/procs');

test('parseDiag: summary keys on the same line are read (line-start anchor bug)', () => {
  const d = parseDiag('scene=Scene_Title\nrenderer=ANGLE (AMD, Radeon RX Vega)\nframes=419 med=16 max=310 span=7211');
  assert.equal(d.scene, 'Scene_Title');
  assert.equal(d.renderer, 'ANGLE (AMD, Radeon RX Vega)');
  assert.equal(d.frames, 419);
  assert.equal(d.med, 16);
  assert.equal(d.max, 310);
  assert.equal(d.span, 7211);
  assert.deepEqual(d.stalls, []);
});

test('parseDiag: append-mode log takes the newest summary and collects stalls', () => {
  const text = [
    'scene=Scene_Title',
    'renderer=llvmpipe',
    'frames=59 med=17 max=210 span=998',
    'stall ms=1421 frame=80',
    'scene=Scene_Title',
    'renderer=llvmpipe',
    'frames=239 med=17 max=1421 span=3990',
    'stall ms=2900 frame=301',
    'error=Cannot read null',
  ].join('\n');
  const d = parseDiag(text);
  assert.equal(d.frames, 239);
  assert.equal(d.max, 1421);
  assert.equal(d.span, 3990);
  assert.equal(d.error, 'Cannot read null');
  assert.deepEqual(d.stalls, ['stall ms=1421 frame=80', 'stall ms=2900 frame=301']);
});

test('descendantCmdline: finds a needle in a direct child cmdline', () => {
  const child = spawn('sleep', ['5']);
  try {
    assert.ok(descendantCmdline(process.pid, 'sleep'));
  } finally {
    child.kill('SIGKILL');
  }
});

test('descendantCmdline: unrelated needle or unrelated root is negative', () => {
  const child = spawn('sleep', ['5']);
  try {
    assert.ok(!descendantCmdline(process.pid, 'definitely-not-a-cmdline-token'));
    // no process descending from 999999 (nonexistent root) can match
    assert.ok(!descendantCmdline(999999, 'sleep'));
  } finally {
    child.kill('SIGKILL');
  }
});
