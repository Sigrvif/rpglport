'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { isPacked, unpack } = require('../app/core/enigma');
const { synthPE } = require('./helpers/fixtures');

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
