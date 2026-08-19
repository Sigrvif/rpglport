'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { analyze } = require('../app/core/detect');
const { fixtureDirs, synthPE, utf16 } = require('./helpers/fixtures');

const stampBlob = (v) => {
  const sep = utf16('\0');
  return Buffer.concat([utf16('ProductVersion'), sep, utf16(v), sep]);
};

test('real fixtures: engine + detectedNW', { skip: fixtureDirs().length === 0 }, () => {
  for (const d of fixtureDirs()) {
    const r = analyze(d);
    assert.ok(r.engine === 'MV' || r.engine === 'MZ', d);
    assert.ok(r.engineVersion, d);
    assert.ok(r.detectedNW, d);
    assert.ok(r.evidence.length >= 2, d);
    if (r.engine === 'MV') {
      assert.equal(r.detectedNW, '0.29.0');
      assert.equal(r.engineVersion, '1.6.1');
      assert.equal(r.payloadRoot, path.join(d, 'www'));
    } else {
      assert.equal(r.detectedNW, '0.48.4'); // browser stamps outrank node.dll's 0.44.0-beta1
    }
  }
});

test('MZ fixture evidence surfaces the mixed-binary disagreement', { skip: !fs.existsSync('<test-games-pool>/MZ/game-mz-1/Game.exe') }, () => {
  const r = analyze('<test-games-pool>/MZ/game-mz-1');
  const srcs = r.evidence.map(e => `${e.src}:${e.value}`);
  assert.ok(srcs.some(s => s.startsWith('nw.dll:0.48.4')));
  assert.ok(srcs.some(s => s.startsWith('node.dll:0.44.0-beta1') || s.includes('14.12.0')));
});

test('synthetic: MZ layout, missing package.json, RPGMAKER_VERSION', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'det-'));
  fs.mkdirSync(path.join(d, 'js'), { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(d, 'js/rmmz_core.js'), 'Utils.RPGMAKER_VERSION = "1.8.0";');
  const r = analyze(d);
  assert.equal(r.engine, 'MZ');
  assert.equal(r.engineVersion, '1.8.0');
  assert.ok(r.flags.includes('missing-package-json'));
  assert.equal(r.detectedNW, null); // no binaries to detect from
});

test('synthetic: not-rpgmaker on random dir; enigma flag via PE sections', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'det2-'));
  assert.equal(analyze(d).flags[0], 'not-rpgmaker');
  fs.writeFileSync(path.join(d, 'Game.exe'), synthPE({ sections: [{ name: '.enigma1' }] }));
  const r = analyze(d);
  assert.ok(r.flags.includes('enigma'));
  assert.ok(r.flags.includes('not-rpgmaker')); // no engine signature yet
});

test('synthetic: browser-tier NW stamps outrank numerically higher node-tier', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'det3-'));
  fs.mkdirSync(path.join(d, 'js'), { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(d, 'js/rmmz_core.js'), 'Utils.RPGMAKER_VERSION = "1.8.0";');
  fs.writeFileSync(path.join(d, 'nw.dll'), synthPE({ utf16: stampBlob('0.48.4') }));
  fs.writeFileSync(path.join(d, 'node.dll'), synthPE({ utf16: stampBlob('0.55.0') }));
  const r = analyze(d);
  assert.equal(r.engine, 'MZ');
  assert.equal(r.detectedNW, '0.48.4'); // browser tier wins despite node tier's 0.55.0
});
