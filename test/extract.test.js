'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { archiveKind, testArchive, extractArchive, resolveGameRoots } = require('../app/core/extract');

const SZ = path.join(__dirname, '..', 'bin', '7zz');
const has7zz = fs.existsSync(SZ);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'));

test('archiveKind detects split volumes by name', () => {
  assert.equal(archiveKind('game.zip.001'), 'split');
  assert.equal(archiveKind('game.7z.002'), 'split');
  assert.equal(archiveKind('game.part1.rar'), 'split');
  assert.equal(archiveKind('game.7z'), null);
  assert.equal(archiveKind('game.zip'), null);
});

test('testArchive/extractArchive round trip', { skip: !has7zz }, async () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'src/www'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src/package.json'), '{"main":"www/index.html"}');
  fs.writeFileSync(path.join(d, 'src/www/index.html'), 'x');
  execFileSync(SZ, ['a', path.join(d, 'game.7z'), path.join(d, 'src')], { stdio: 'pipe' });
  const t = await testArchive(SZ, path.join(d, 'game.7z'));
  assert.deepEqual([t.ok, t.split, t.encrypted], [true, false, false]);
  const out = path.join(d, 'out');
  const ex = await extractArchive(SZ, path.join(d, 'game.7z'), out);
  assert.equal(ex.ok, true);
  assert.ok(fs.existsSync(path.join(out, 'src/www/index.html')));
});

test('testArchive reports encrypted archives', { skip: !has7zz }, async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'f.txt'), 'data');
  execFileSync(SZ, ['a', '-psecret', path.join(d, 'enc.7z'), path.join(d, 'f.txt')], { stdio: 'pipe' });
  const t = await testArchive(SZ, path.join(d, 'enc.7z'));
  assert.equal(t.encrypted, true);
  assert.equal(t.ok, false);
});

test('resolveGameRoots: direct MV, nested single child, multi-game archive', () => {
  const mkMV = (base, name) => {
    fs.mkdirSync(path.join(base, name, 'www'), { recursive: true });
    fs.mkdirSync(path.join(base, name, 'js'), { recursive: true }); // not needed for MV match
    fs.writeFileSync(path.join(base, name, 'package.json'), '{}');
    fs.writeFileSync(path.join(base, name, 'www/index.html'), 'x');
  };
  const d1 = tmp(); mkMV(d1, 'game');
  assert.deepEqual(resolveGameRoots(d1), [path.join(d1, 'game')]);     // parent itself is not a root; child is
  const d2 = tmp(); fs.mkdirSync(path.join(d2, 'inner')); mkMV(d2, 'inner/game');
  assert.deepEqual(resolveGameRoots(d2), [path.join(d2, 'inner/game')]);
  const d3 = tmp(); mkMV(d3, 'g1'); mkMV(d3, 'g2');
  assert.deepEqual(resolveGameRoots(d3).sort(), [path.join(d3, 'g1'), path.join(d3, 'g2')]);
});
