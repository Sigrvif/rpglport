'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { isPacked, unpack, toPosix, safeJoin, admitSize, readFileBig } = require('../app/core/enigma');
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

test('admitSize: RAM-aware admission, 4 GiB PE format cap (no arbitrary 2 GiB rule)', () => {
  const GiB = 1024 ** 3;
  assert.equal(admitSize(385 * 1024 ** 2, 8 * GiB).ok, true);   // typical packed game
  assert.equal(admitSize(3 * GiB, 24 * GiB).ok, true);          // > 2 GiB fine when RAM allows
  const format = admitSize(5 * GiB, 24 * GiB);                  // beyond PE 32-bit offsets
  assert.equal(format.ok, false);
  assert.match(format.reason, /4 GiB/);
  const ram = admitSize(3 * GiB, 3 * GiB);                      // needs 3 GiB, ~2.25 GiB budget
  assert.equal(ram.ok, false);
  assert.match(ram.reason, /RAM/);
});

test('readFileBig: full-read of any size; bypasses the readFileSync 2 GiB cap', { skip: os.freemem() < 4 * 1024 ** 3, timeout: 180000 }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'big-'));
  const p = path.join(d, 'big.bin');
  const SIZE = Math.floor(2.2 * 1024 ** 3);                     // deliberately past the old limit
  const fd = fs.openSync(p, 'w');
  fs.writeSync(fd, Buffer.from([0x4d, 0x5a, 0x01, 0x02]), 0, 4, 0);
  fs.closeSync(fd);
  fs.truncateSync(p, SIZE);                                      // sparse body
  const buf = readFileBig(p);
  assert.equal(buf.length, SIZE);
  assert.equal(buf[0], 0x4d);                                    // real bytes read
  assert.equal(buf.readUInt32LE(2 * 1024 ** 3 + 4), 0);          // addressable past 2 GiB
  assert.throws(() => fs.readFileSync(p), /ERR_FS_FILE_TOO_LARGE|2 GiB/); // documents why readFileBig exists
  fs.rmSync(d, { recursive: true, force: true });
});
