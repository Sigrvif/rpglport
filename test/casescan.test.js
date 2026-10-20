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

test('encrypted variant (rpgmvp/rpgmvo/rpgmvm) case fix: refs carry the plain extension', () => {
  // MV Decrypter swaps .png→.rpgmvp at load time; Windows loaded it through the
  // case-insensitive open, so encrypted games ship any casing they like.
  const root = mkGame({
    'img/characters/$heroine_Petoria.rpgmvp': 'x',                  // disk: capital P
    'audio/bgm/Theme.MP3.rpgmvo': 'x',                              // mp3 never swapped — sibling-only base
    'data/Actors.json': JSON.stringify([{ characterName: '$heroine_petoria' }]), // ref: lowercase
  });
  const r = scan(root);
  assert.deepEqual(r.fixes, [{ actual: 'img/characters/$heroine_Petoria.rpgmvp', ref: 'img/characters/$heroine_petoria.rpgmvp' }]);
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.missing.length, 0);                                // not missing — sibling exists
});

test('encrypted variant: already-referenced casing → no fix; multiple stems → duplicate', () => {
  const ok = mkGame({
    'img/characters/$heroine_petoria.rpgmvp': 'x',
    'data/Actors.json': JSON.stringify([{ characterName: '$heroine_petoria' }]),
  });
  let r = scan(ok);
  assert.deepEqual(r.fixes, []);
  const multi = mkGame({
    'img/characters/$heroine_Petoria.rpgmvp': 'x',
    'data/a.json': JSON.stringify([{ characterName: '$heroine_petoria' }, { characterName: '$heroine_petoria' }, { characterName: '$heroine_Petoria' }]),
  });
  r = scan(multi);
  assert.deepEqual(r.fixes, [{ actual: 'img/characters/$heroine_Petoria.rpgmvp', ref: 'img/characters/$heroine_petoria.rpgmvp' }]);
  assert.deepEqual(r.duplicates, [{ target: 'img/characters/$heroine_petoria.rpgmvp', as: 'img/characters/$heroine_Petoria.rpgmvp' }]);
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

test('referenced minority DISK casing is materialized after majority rename', () => {
  const root = mkGame({
    'img/pictures/Shot.png': 'x',
    'data/a.json': JSON.stringify([{ pictureName: 'shot' }, { pictureName: 'shot' }, { pictureName: 'Shot' }]),
  });
  const r = scan(root);
  assert.deepEqual(r.fixes, [{ actual: 'img/pictures/Shot.png', ref: 'img/pictures/shot.png' }]);
  assert.deepEqual(r.duplicates, [{ target: 'img/pictures/shot.png', as: 'img/pictures/Shot.png' }]);
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
  assert.equal(r.missing.length, 1);                                 // all probed extensions of one base → one entry
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

test("MZ weak encryption (_-suffix) case fix: Bitmap fetches url+\"_\" when hasEncryptedImages", () => {
  // System.json hasEncryptedImages → rmmz_core fetches img/characters/%24name.png
  // as name.png + "_" — Windows resolved $Transparent.png_ case-insensitively,
  // Linux needs the referenced casing on disk. Refs arrive via Ayatam note tags
  // (<acg character: $name, opts>), not data keys.
  const root = mkGame({
    "img/characters/$Transparent.png_": "png",
    "data/Map001.json": JSON.stringify([{ parameters: ["<acg character: $transparent, 0>"] }]),
  });
  const r = scan(root);
  assert.deepEqual(r.fixes, [{ actual: "img/characters/$Transparent.png_", ref: "img/characters/$transparent.png_" }]);
  assert.equal(r.missing.length, 0);
});

test("MZ weak encryption: both casings referenced → duplicate materializes each", () => {
  const root = mkGame({
    "img/characters/$Transparent.png_": "png",
    "data/Map001.json": JSON.stringify([
      { parameters: ["<acg character: $transparent, 0>"] },
      { characterName: "$Transparent" },
    ]),
  });
  const r = scan(root);
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.duplicates, [{ target: "img/characters/$Transparent.png_", as: "img/characters/$transparent.png_" }]);
  assert.equal(r.missing.length, 0);
});

test("acg note tag with subdir name resolves under img/characters", () => {
  const root = mkGame({
    "img/characters/Map/Hide/!$Hide_locker_frames1_asPic.png_": "png",
    "data/Map001.json": JSON.stringify([{ parameters: ["<acg character: Map/Hide/!$Hide_locker_frames1_asPic, 0>"] }]),
  });
  const r = scan(root);
  assert.deepEqual(r.fixes, []);
  assert.equal(r.missing.length, 0);   // exact case on disk and in the tag → clean
});
