'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { readPE, nodeStamps, chromeStamps } = require('../app/core/pe');
const { fixtureDirs, synthPE, utf16 } = require('./helpers/fixtures');

test('synthetic PE: arch + sections parsed; garbage returns null', () => {
  const buf = synthPE({ machine: 0x8664, sections: [{ name: '.enigma1' }, { name: '.text' }] });
  const pe = readPE(buf);
  assert.equal(pe.arch, 'x64');
  assert.deepEqual(pe.sections.map(s => s.name), ['.enigma1', '.text']);
  assert.equal(readPE(Buffer.from('MZ' + 'garbage'.repeat(4))), null);   // too short
  assert.equal(readPE(Buffer.from('not a pe at all........')), null);
});

test('synthetic PE: ProductVersion stamps extracted from UTF-16 resources', () => {
  // Resource strings are NUL-separated UTF-16 runs — separators are required
  // for utf16Runs to split key from value.
  const sep = utf16('\0');
  const blob = Buffer.concat([utf16('ProductVersion'), sep, utf16('0.48.4'), sep,
    utf16('Padding'), sep, utf16('FileVersion'), sep, utf16('0.48.4'), sep]);
  const pe = readPE(synthPE({ utf16: blob }));
  assert.deepEqual(pe.stamps, ['0.48.4']);
});

test('node/chrome string collectors', () => {
  const buf = Buffer.concat([Buffer.from('xx node.js/v14.12.0 yy '), Buffer.from('Chrome/85.0.4183 zz')]);
  assert.deepEqual(nodeStamps(buf), ['14.12.0']);
  assert.deepEqual(chromeStamps(buf).majors, ['85']);
});

test('real fixtures: stamps match validated ground truth', { skip: fixtureDirs().length === 0 }, t => {
  // Ground truth (verified against the actual binaries during design/review):
  //  - MV: Game.exe/nw.dll carry NO PE version stamps; node.dll has `node.js/v9.7.1`
  //    and no Chrome/ strings; the chromium evidence is the BARE full version
  //    `65.0.3325.146` inside Game.exe/nw.dll.
  //  - MZ: nw.dll/Game.exe stamp `0.48.4` in PE resources; node.dll carries NO
  //    node.js/v string — its evidence is the PE resource stamp `0.44.0-beta1`.
  for (const d of fixtureDirs()) {
    const exeBuf = fs.readFileSync(`${d}/Game.exe`);
    const exe = readPE(exeBuf);
    assert.ok(exe.arch === 'x64' || exe.arch === 'x86', d);
    const nwDll = readPE(fs.readFileSync(`${d}/nw.dll`));
    const nodeDllBuf = fs.readFileSync(`${d}/node.dll`);
    const nodeDll = readPE(nodeDllBuf);
    const isMZ = fs.existsSync(`${d}/js/rmmz_core.js`);
    if (isMZ) {
      assert.ok(nwDll.stamps.includes('0.48.4'), d);
      assert.ok(nodeDll.stamps.includes('0.44.0-beta1'), d);          // PE resource, not a string
      assert.ok(chromeStamps(exeBuf).fulls.includes('85.0.4183.121'), d);
    } else {
      assert.deepEqual(nodeStamps(nodeDllBuf), ['9.7.1'], d);
      assert.ok(chromeStamps(exeBuf).fulls.includes('65.0.3325.146'), d);
    }
  }
});
