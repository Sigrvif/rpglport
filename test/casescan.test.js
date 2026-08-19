'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { scan, destIsCaseInsensitive } = require('../app/core/casescan');

function mkGame(build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  for (const [rel, content] of Object.entries(build)) {
    if (rel.endsWith('/')) fs.mkdirSync(path.join(root, rel), { recursive: true });
    else {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
  }
  return root;
}

test('unique wrong-case ref → rename fix', () => {
  const root = mkGame({
    'img/faces/Actor1.PNG': 'png',                                  // disk: upper ext
    'data/Actors.json': JSON.stringify([{ faceName: 'Actor1' }]),   // ref: no ext
  });
  const r = scan(root);
  assert.deepEqual(r.fixes, [{ actual: 'img/faces/Actor1.PNG', ref: 'img/faces/Actor1.png' }]);
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.counts.fixes, 1);
});

test('majority casing wins, minority materialized; tie keeps disk casing', () => {
  // Refs live in data/*.json — the key-table collector only walks data/ and js/.
  const root = mkGame({
    'img/pictures/Shot.png': 'x',
    'data/a.json': JSON.stringify([{ pictureName: 'Shot' }, { pictureName: 'shot' }, { pictureName: 'SHOT' }]),
    'data/b.json': JSON.stringify([{ pictureName: 'Shot' }]),             // Shot majority (2 vs 1 vs 1)
  });
  let r = scan(root);
  assert.deepEqual(r.fixes, []);                                    // disk casing == majority
  assert.deepEqual(r.duplicates, [{ target: 'img/pictures/Shot.png', as: 'img/pictures/shot.png' }, { target: 'img/pictures/Shot.png', as: 'img/pictures/SHOT.png' }]);
  const tie = mkGame({
    'img/pictures/Shot.png': 'x',
    'data/a.json': JSON.stringify([{ pictureName: 'shot' }, { pictureName: 'SHOT' }]), // 1:1 tie → keep disk
  });
  r = scan(tie);
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.duplicates, [{ target: 'img/pictures/Shot.png', as: 'img/pictures/shot.png' }, { target: 'img/pictures/Shot.png', as: 'img/pictures/SHOT.png' }]);
});

test('case-distinct files → conflict; unknown ref → missing', () => {
  const root = mkGame({
    'img/faces/Actor1.png': 'a', 'img/faces/ACTOR1.png': 'b',
    'data/Actors.json': JSON.stringify([{ faceName: 'Actor1' }, { faceName: 'Ghost' }]),
  });
  const r = scan(root);
  assert.equal(r.conflicts.length, 1);
  assert.ok(r.conflicts[0].files.includes('img/faces/Actor1.png'));
  assert.ok(r.missing.includes('img/faces/Ghost.png'));
});

test('literal scan catches plugin paths (backslash + non-ASCII); audio via literal only', () => {
  // Fixture semantics: single literal ref to a wrong-cased file → rename fix.
  // Title2 is a 1:1 tie (data ref vs literal ref) → keep disk casing,
  // materialize the other casing as duplicate.
  const root = mkGame({
    'img/pictures/Title2.png': 'x', 'audio/bgm/Theme.ogg': 'o',
    'img/日本/町A.png': 'y',
    'js/plugins/fancy.js': 'load("img\\pictures\\title2.png"); play("audio/bgm/theme.ogg");',
    'data/System.json': JSON.stringify({ pictureName: 'Title2' }),
    'js/refs.js': 'const p = "img/日本/町a.png";',
  });
  const r = scan(root);
  assert.ok(r.fixes.some(f => f.actual === 'audio/bgm/Theme.ogg' && f.ref === 'audio/bgm/theme.ogg'));
  assert.ok(r.fixes.some(f => f.actual === 'img/日本/町A.png' && f.ref === 'img/日本/町a.png'));
  assert.ok(!r.fixes.some(f => f.actual === 'img/pictures/Title2.png'));  // tie → no rename
  assert.ok(r.duplicates.some(d => d.as === 'img/pictures/title2.png'));  // tie → materialize other casing
});

test('malformed data JSON is skipped, literal scan still works', () => {
  const root = mkGame({
    'img/faces/Actor1.png': 'x',
    'data/Actors.json': '{broken',
    'data/System.json': JSON.stringify({ test: 1 }),
    'js/x.js': '"img/faces/actor1.png"',
  });
  const r = scan(root);
  assert.ok(r.fixes.some(f => f.actual === 'img/faces/Actor1.png'));
  assert.ok(r.scanErrors === 1);
});

test('destIsCaseInsensitive detects CI mounts', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-'));
  assert.equal(typeof destIsCaseInsensitive(d), 'boolean'); // tmpfs/ext4 → false on Linux dev box
});

test('real fixtures: zero unresolved conflicts', { skip: !require('./helpers/fixtures').fixtureDirs().length }, () => {
  const { fixtureDirs } = require('./helpers/fixtures');
  const detect = require('../app/core/detect');
  for (const dir of fixtureDirs()) {
    const info = detect.analyze(dir);
    if (!info.payloadRoot) continue;
    const r = scan(info.payloadRoot);
    assert.equal(r.conflicts.length, 0, dir);
  }
});
