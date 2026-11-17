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
  // Structural ground truth (verified against real binaries during
  // design/review; the local pool varies, so exact versions are not pinned —
  // the original dev pool validated node 9.7.1 / Chromium 65.0.3325.146 for
  // MV and nw 0.48.4 / node.dll resource stamp 0.44.0-beta1 / Chromium
  // 85.0.4183.121 for MZ):
  //  - MV: node.dll carries node.js/v STRING stamps (its Chromium evidence
  //    is the bare full version inside Game.exe/nw.dll).
  //  - MZ: nw.dll stamps the nw version in PE resources; node.dll carries
  //    NO node.js/v string — its evidence is a PE resource stamp.
  const semver = v => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v);
  for (const d of fixtureDirs()) {
    const exeBuf = fs.readFileSync(`${d}/Game.exe`);
    const exe = readPE(exeBuf);
    assert.ok(exe.arch === 'x64' || exe.arch === 'x86', d);
    const nwDll = readPE(fs.readFileSync(`${d}/nw.dll`));
    const nodeDllBuf = fs.readFileSync(`${d}/node.dll`);
    const nodeDll = readPE(nodeDllBuf);
    const isMZ = fs.existsSync(`${d}/js/rmmz_core.js`);
    if (isMZ) {
      assert.ok(nwDll.stamps.some(semver), d);                        // PE resource, not a string
      assert.equal(nodeStamps(nodeDllBuf).length, 0, d);              // no node.js/v string
      assert.ok(nodeDll.stamps.some(semver), d);
    } else {
      // Repacked/alt builds may carry no node.js string stamps at all —
      // whatever is present must parse.
      assert.ok(nodeStamps(nodeDllBuf).every(semver), d);
    }
    // Some pool games carry no bare Chromium full-version strings at all —
    // when present, they must parse as four-part Chromium versions.
    assert.ok(chromeStamps(exeBuf).fulls.every(v => /^\d+\.\d+\.\d+\.\d+$/.test(v)), d);
  }
});
