'use strict';
// Pipeline orchestration: input → game cards; serialized port queue; selftest.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { analyze } = require('./detect');
const { archiveKind, testArchive, extractArchive, resolveGameRoots } = require('./extract');
const enigma = require('./enigma');
const { listPool } = require('./select');
const { scan } = require('./casescan');
const { buildPort } = require('./port');

const TMP = () => path.join(os.homedir(), '.cache', 'rpglport', 'tmp');
let cardSeq = 0;

function analyzeCard(gameDir, source, extra = {}) {
  return { id: `c${++cardSeq}`, name: path.basename(gameDir), gameDir, info: analyze(gameDir), source, warnings: [], ...extra };
}

async function analyzeInput(inputPath, { sevenZip }) {
  const cards = [];
  const mkCard = (extra) => cards.push({ id: `c${++cardSeq}`, ...extra });
  let stat = null;
  try { stat = fs.statSync(inputPath); } catch {
    mkCard({ name: path.basename(inputPath), error: 'path does not exist', warnings: [] });
    return { cards };
  }
  if (stat.isDirectory()) {
    for (const root of resolveGameRoots(inputPath)) {
      const card = analyzeCard(root, 'folder');
      // compiled-MV "app.nw" bundle (spec §7): unzip via 7zz, re-analyze contents
      if (card.info && card.info.flags.includes('app-nw') && sevenZip) {
        try {
          fs.mkdirSync(TMP(), { recursive: true });
          const dest = fs.mkdtempSync(path.join(TMP(), 'appnw-'));
          const ex = await extractArchive(sevenZip, path.join(root, 'app.nw'), dest);
          if (ex.ok) {
            const inner = analyze(dest);
            if (inner.engine) {
              card.info = inner;
              card.gameDir = dest;
              card.extractDir = dest;                                  // GUI's doPost cleans this up after porting per settings.keepExtracted
              card.warnings.push('app.nw payload extracted for porting');
            }
          }
        } catch { /* keep outer analysis; porting will fail loudly on payload */ }
      }
      cards.push(card);
    }
    if (!cards.length) mkCard({ name: path.basename(inputPath), error: 'no RPG Maker MV/MZ game found in this folder', warnings: [] });
    return { cards };
  }
  const kind = archiveKind(path.basename(inputPath));
  if (kind === 'split') {
    mkCard({ name: path.basename(inputPath), error: 'split archive — join/finish the download first', warnings: [] });
    return { cards };
  }
  if (kind === 'archive') {
    const t = await testArchive(sevenZip, inputPath);
    if (!t.ok) {
      mkCard({ name: path.basename(inputPath), error: t.reason, warnings: [] });
      return { cards };
    }
    fs.mkdirSync(TMP(), { recursive: true });
    const dest = fs.mkdtempSync(path.join(TMP(), 'x-'));
    const ex = await extractArchive(sevenZip, inputPath, dest);
    if (!ex.ok) { mkCard({ name: path.basename(inputPath), error: 'extraction failed', warnings: [] }); return { cards }; }
    for (const root of resolveGameRoots(dest)) {
      cards.push(analyzeCard(root, 'archive', { extractDir: dest }));  // GUI's doPost cleans this up after porting per settings.keepExtracted
    }
    if (!cards.length) mkCard({ name: path.basename(inputPath), error: 'no game found in archive', warnings: [] });
    return { cards };
  }
  if (/\.(exe|bin)$/i.test(inputPath)) {
    let packed = false;
    try {
      // read at most the first 2 MiB — the PE/section headers we probe for
      // .enigma1 live near the file start, and a packed exe can be ~1 GB
      const fd = fs.openSync(inputPath, 'r');
      const head = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 2 * 1024 * 1024));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      packed = enigma.isPacked(head);
    } catch { /* fallthrough */ }
    if (packed) {
      fs.mkdirSync(TMP(), { recursive: true });
      const out = fs.mkdtempSync(path.join(TMP(), 'enig-'));
      const r = await enigma.unpack(inputPath, out);
      for (const root of resolveGameRoots(out)) {
        cards.push(analyzeCard(root, 'enigma', { extractDir: out, warnings: [`EnigmaVB ${r.enigmaVersion}: ${r.fileCount} files unpacked`] }));
      }
      if (!cards.length) mkCard({ name: path.basename(inputPath), error: 'EnigmaVB unpacked but no game tree found', warnings: [] });
      return { cards };
    }
    mkCard({ name: path.basename(inputPath), error: 'single exe drop: only EnigmaVB-packed game executables are supported', warnings: [] });
    return { cards };
  }
  mkCard({ name: path.basename(inputPath), error: 'unsupported input — drop a game folder, an archive, or a packed exe', warnings: [] });
  return { cards };
}

async function portCard(card, opts) {
  if (!card.info || !card.info.payloadRoot) throw new Error('card has no analyzable game payload');
  if (!card.scan) card.scan = card.info.payloadRoot ? scan(card.info.payloadRoot) : { fixes: [], duplicates: [], conflicts: [], missing: [], counts: { fixes: 0, warnings: 0 } };
  return buildPort({
    gameDir: card.gameDir, info: card.info, scan: card.scan,
    runtimeDir: opts.runtime.path, runtimeVersion: opts.runtime.version,
    outParent: opts.outParent, dirName: opts.dirName,
    onExists: opts.onExists || 'refuse', onProgress: opts.onProgress, cancel: opts.cancel,
  });
}

class PortQueue {
  // Serialized worker (spec §8). enqueue returns { promise, token }; cancelling
  // a token drops that job if still queued, or stops an in-flight port at the
  // next file boundary (the same token object is handed to buildPort).
  constructor() { this.chain = Promise.resolve(); }
  enqueue(fn) {
    const token = { cancelled: false };
    const run = this.chain.then(() => {
      if (token.cancelled) throw new Error('cancelled before start');
      return fn(token);
    });
    this.chain = run.catch(() => {});
    return { promise: run, token };
  }
}

async function selftest(bundleRoot) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  try {
    const map = require('./nwmap.json');
    add('nwmap', map.versions['0.29.0'] && map.versions['0.48.4'], `${Object.keys(map.versions).length} versions`);
  } catch (e) { add('nwmap', false, String(e)); }
  await new Promise((res) => {
    const sz = path.join(bundleRoot, 'bin', '7zz');
    if (!fs.existsSync(sz)) { add('7zz', false, 'bin/7zz missing'); return res(); }
    const p = spawn(sz, ['i'], { stdio: 'ignore' });
    p.on('error', () => { add('7zz', false, 'spawn failed'); res(); });
    p.on('close', c => { add('7zz', c === 0); res(); });   // result recorded on close, not before
  });
  try {
    const { pool, rejected } = listPool(bundleRoot);
    add('pool', pool.length >= 6 && pool.some(p => p.source === 'host'), `${pool.length} runtimes (${rejected.length} rejected)`);
  } catch (e) { add('pool', false, String(e)); }
  return { ok: checks.every(c => c.ok), checks };
}

module.exports = { analyzeInput, portCard, PortQueue, selftest, TMP };
