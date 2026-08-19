'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { buildPort, slugify } = require('../app/core/port');

const RT = 'runtimes/nwjs-v0.29.0-linux-x64';  // real runtime from fetch-dev-deps
const haveRT = fs.existsSync(path.join(RT, 'nw'));

function mkMV(base, name = 'Test Game') {
  const g = path.join(base, name.replace(/\s+/g, '_'));
  fs.mkdirSync(path.join(g, 'www/img/faces'), { recursive: true });
  fs.mkdirSync(path.join(g, 'www/data'), { recursive: true });
  fs.writeFileSync(path.join(g, 'Game.exe'), Buffer.alloc(64));
  fs.writeFileSync(path.join(g, 'node.dll'), Buffer.alloc(64));
  fs.writeFileSync(path.join(g, 'icudtl.dat'), Buffer.alloc(16));
  fs.writeFileSync(path.join(g, 'package.json'), JSON.stringify({ main: 'www/index.html', 'js-flags': '--expose-gc' }));
  fs.writeFileSync(path.join(g, 'www/index.html'), '<html>game</html>');
  fs.writeFileSync(path.join(g, 'www/img/faces/Actor1.PNG'), 'png');
  fs.writeFileSync(path.join(g, 'www/data/Actors.json'), JSON.stringify([{ faceName: 'Actor1' }]));
  return g;
}

test('slugify', () => {
  // NFKD strips kana/kanji (no transliteration — by design); ASCII slugs survive.
  // All-Japanese names fall back to a constant slug (NOTES.txt records the original).
  assert.equal(slugify('game-mz-2 1.5'), '1-5');
  assert.equal(slugify('My GAME!'), 'my-game');
  assert.equal(slugify('アニマ'), 'rpg-port-game');                           // never empty
});

test('buildPort end-to-end on real runtime', { skip: !haveRT }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'port-'));
  const game = mkMV(base);
  const out = path.join(base, 'out');
  const r = await buildPort({
    gameDir: game,
    info: { engine: 'MV', payloadRoot: path.join(game, 'www') },
    scan: { fixes: [{ actual: 'img/faces/Actor1.PNG', ref: 'img/faces/Actor1.png' }], duplicates: [], conflicts: [], missing: [], counts: { fixes: 1, warnings: 0 } },
    runtimeDir: RT,
    outParent: out,
    dirName: 'Test Game (Linux)',
    onExists: 'refuse',
  });
  const port = r.finalDir;
  assert.ok(fs.existsSync(path.join(port, 'nw')));
  assert.ok(fs.statSync(path.join(port, 'nw')).mode & 0o111);
  assert.ok(!fs.existsSync(path.join(port, 'Game.exe')));
  assert.ok(!fs.existsSync(path.join(port, 'node.dll')));
  assert.ok(!fs.existsSync(path.join(port, 'icudtl.dat')));
  assert.ok(fs.existsSync(path.join(port, 'www/index.html')));
  assert.ok(fs.existsSync(path.join(port, 'www/img/faces/Actor1.png')));      // renamed
  assert.ok(!fs.existsSync(path.join(port, 'www/img/faces/Actor1.PNG')));
  assert.ok(fs.existsSync(path.join(port, 'start.sh')));
  assert.ok(fs.statSync(path.join(port, 'start.sh')).mode & 0o111);
  const pkg = JSON.parse(fs.readFileSync(path.join(port, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'www/index.html');
  assert.equal(pkg['js-flags'], '--expose-gc');
  assert.match(pkg.name, /^test-game/);
  assert.match(fs.readFileSync(path.join(port, 'NOTES.txt'), 'utf8'), /0\.29\.0/);
  const so = fs.readFileSync(path.join(port, 'lib/libnode.so'));
  assert.ok(so.length > 1000);
});

test('buildPort: existing dest refuse/overwrite/newname', { skip: !haveRT }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'port2-'));
  const game = mkMV(base);
  const out = path.join(base, 'out');
  const baseOpts = () => ({ gameDir: game, info: { engine: 'MV', payloadRoot: path.join(game, 'www') }, scan: { fixes: [], duplicates: [], conflicts: [], missing: [], counts: { fixes: 0, warnings: 0 } }, runtimeDir: RT, outParent: out, dirName: 'G', onExists: 'refuse' });
  await buildPort(baseOpts());
  await assert.rejects(() => buildPort(baseOpts()), /exists/);
  const ow = await buildPort({ ...baseOpts(), onExists: 'overwrite' });
  assert.equal(ow.finalDir, path.join(out, 'G'));
  const nn = await buildPort({ ...baseOpts(), onExists: 'newname' });
  assert.match(path.basename(nn.finalDir), /^G-2$/);
});

test('cancel token stops at file boundary and cleans temp dir', { skip: !haveRT }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'port3-'));
  const game = mkMV(base);
  const cancel = { cancelled: false };
  const p = buildPort({ gameDir: game, info: { engine: 'MV', payloadRoot: path.join(game, 'www') }, scan: { fixes: [], duplicates: [], conflicts: [], missing: [], counts: { fixes: 0, warnings: 0 } }, runtimeDir: RT, outParent: path.join(base, 'out'), dirName: 'G', onExists: 'refuse', cancel, onProgress: () => { cancel.cancelled = true; } });
  await assert.rejects(() => p, /cancel/i);
  assert.equal(fs.readdirSync(path.join(base, 'out')).filter(n => n.startsWith('.tmp-')).length, 0);
});
