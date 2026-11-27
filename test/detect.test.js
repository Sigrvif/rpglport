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
    // Structural expectations hold for ANY game in the local pool; exact NW
    // versions vary per game and are not pinned here (the pinned values of
    // the original dev pool were 0.29.0 for MV and 0.48.4 for MZ).
    assert.ok(/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(r.detectedNW), d);
    if (r.engine === 'MV') {
      assert.ok(/^\d+\.\d+\.\d+$/.test(r.engineVersion), d);
      // stock MV deploys under www/; loose deployments are their own root
      assert.ok([path.join(d, 'www'), d].includes(r.payloadRoot), d);
    }
  }
});

const MIXED = process.env.RPGLPORT_MIXED_MZ_GAME || '';
test('MZ fixture evidence surfaces the mixed-binary disagreement', { skip: !MIXED || !fs.existsSync(path.join(MIXED, 'Game.exe')) }, () => {
  const r = analyze(MIXED);
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

test("synthetic: loose MV layout (no www/, game-titled exe) detects as MV", () => {
  // 姫騎士エレーナ-style deployment: index.html at the root, js/rpg_core.js,
  // exe named after the game — MZ-style packaging of an MV payload.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "det-loose-"));
  fs.mkdirSync(path.join(d, "js"), { recursive: true });
  fs.writeFileSync(path.join(d, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(d, "js/rpg_core.js"), 'Utils.RPGMAKER_VERSION = "1.6.1";');
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "x", main: "index.html" }));
  fs.writeFileSync(path.join(d, "\u59eb\u9a0e\u58eb.exe"), synthPE({ sections: [{ name: ".text" }] }));
  const r = analyze(d);
  assert.equal(r.engine, "MV");
  assert.equal(r.engineVersion, "1.6.1");
  assert.equal(r.payloadRoot, d);            // the root IS the payload
  assert.equal(r.packageJsonPath, path.join(d, "package.json"));
});
