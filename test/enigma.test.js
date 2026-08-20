'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { isPacked, unpack, toPosix, safeJoin, admitSize } = require('../app/core/enigma');
const { synthPE } = require('./helpers/fixtures');

test('toPosix: Windows separators become forward slashes', () => {
  assert.equal(toPosix('a\\b\\c.png'), 'a/b/c.png');
  assert.equal(toPosix('plain.png'), 'plain.png');
});

test('safeJoin: rejects traversal, accepts normal rel, empty rel → base', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sj-'));
  assert.throws(() => safeJoin(d, '../escape'), /unsafe path/);
  assert.equal(safeJoin(d, 'a/b.png'), path.join(d, 'a/b.png'));
  assert.equal(safeJoin(d, ''), d);
});

test('isPacked: true for .enigma1 section, false otherwise, null for non-PE', () => {
  const packed = synthPE({ sections: [{ name: '.enigma1' }, { name: '.enigma2' }] });
  const plain = synthPE({ sections: [{ name: '.text' }] });
  assert.equal(isPacked(packed), true);
  assert.equal(isPacked(plain), false);
  assert.equal(isPacked(Buffer.from('nope')), null);
});

test('unpack rejects non-Enigma input with clear error', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'enig-'));
  const exe = path.join(d, 'Game.exe');
  fs.writeFileSync(exe, synthPE({ sections: [{ name: '.text' }] }));
  await assert.rejects(() => unpack(exe, path.join(d, 'out')), /enigma1|Enigma/i);
});

test('admitSize: 4 GiB PE format cap; no RAM rule (file-backed upstream does flat-memory reads)', () => {
  const GiB = 1024 ** 3;
  assert.equal(admitSize(385 * 1024 ** 2).ok, true);   // typical packed game
  assert.equal(admitSize(3 * GiB).ok, true);          // > 2 GiB fine — upstream 1.1.0 is file-backed
  const format = admitSize(5 * GiB);                  // beyond PE 32-bit offsets
  assert.equal(format.ok, false);
  assert.match(format.reason, /4 GiB/);
});
