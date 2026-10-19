'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const { descendantCmdline } = require('../app/core/procs');

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
