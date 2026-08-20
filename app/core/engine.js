'use strict';
// Pipeline orchestration: input → game cards; serialized port queue; selftest.
const fs = require('fs');
const net = require('net');
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

// Live X displays, most-recently-used first. A socket FILE in /tmp/.X11-unix
// can outlive its server, so each candidate is connect-probed. Used by the
// GUI's Test Run to recover when the tool itself was launched with a stale
// DISPLAY (its children inherit it, not the user's shell).
function socketAlive(socketPath, timeoutMs = 300) {
  return new Promise((resolve) => {
    const s = net.connect({ path: socketPath });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

async function findLiveDisplays(dir = '/tmp/.X11-unix') {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = n.match(/^X(\d+)$/);
    if (!m) continue;
    if (await socketAlive(path.join(dir, n))) out.push(`:${m[1]}`);
  }
  // :0 first — the primary display of a normal desktop session
  return out.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function hasXvfbRun() {
  for (const d of (process.env.PATH || '').split(':')) {
    if (d && fs.existsSync(path.join(d, 'xvfb-run'))) return true;
  }
  return false;
}

// Working DISPLAY+XAUTHORITY pairs observed in this user's processes. A live
// socket alone is not enough: the server may reject clients that lack the
// session cookie (GTK then reports the same "cannot open display"). The pair
// used by an already-running session process (terminal, file manager,
// compositor helper) is authoritative. Same-uid processes only.
function readEnviron(pidDir) {
  try {
    const buf = fs.readFileSync(path.join(pidDir, 'environ'));
    const out = {};
    for (const kv of buf.toString('latin1').split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return out;
  } catch { return null; }
}

function findProcDisplayPairs(procDir = '/proc') {
  const uid = process.getuid();
  const seen = new Set(); // display|auth — ALL distinct pairs: a display can be
  // seen first with a STALE authority in one process while the session's live
  // one sits in another, so first-wins would hide the working pair.
  const out = [];
  let entries;
  try { entries = fs.readdirSync(procDir, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
    const d = path.join(procDir, e.name);
    try { if (fs.statSync(d).uid !== uid) continue; } catch { continue; }
    const env = readEnviron(d);
    if (!env || !env.DISPLAY || !/^:\d+(\.\d+)?$/.test(env.DISPLAY)) continue;
    const display = env.DISPLAY.replace(/\.\d+$/, '');  // :0.0 → :0
    const key = `${display}|${env.XAUTHORITY || ''}`;
    if (!seen.has(key)) { seen.add(key); out.push({ display, xauthority: env.XAUTHORITY || null }); }
  }
  return out;
}

// Standard Xauthority locations used by display managers, for when no running
// process exposes the session's current authority via /proc.
function xauthorityCandidates() {
  const out = [];
  const uid = process.getuid();
  const home = os.homedir();
  const paths = [
    path.join(home, '.Xauthority'),                       // classic / KDE / SDDM
    `/run/user/${uid}/gdm/Xauthority`,                    // GDM X11 sessions
  ];
  for (const p of paths) if (fs.existsSync(p)) out.push(p);
  try { // mutter/XWayland per-boot authorities (random suffix)
    const runDir = `/run/user/${uid}`;
    for (const e of fs.readdirSync(runDir)) {
      if (e.startsWith('.mutter-Xwaylandauth.')) out.push(path.join(runDir, e));
    }
  } catch { /* no /run/user */ }
  return out;
}

// Whole working environments observed in this user's processes. When the
// correct DISPLAY+XAUTHORITY pair alone is rejected, the tool's own inherited
// environment is poisoned for X (stale WAYLAND_DISPLAY, GDK_BACKEND forced,
// dead XDG_RUNTIME_DIR…) — and a pair-based retry keeps carrying that poison.
// A session process (terminal, file manager) holds the COMPLETE environment
// under which launching the game verifiably works; adopting it wholesale
// replicates that. Same-uid, live displays only, deduped, session-y first.
function findSessionEnvs(procDir = '/proc', liveDisplays = null, cap = 6) {
  const uid = process.getuid();
  let entries;
  try { entries = fs.readdirSync(procDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
    const d = path.join(procDir, e.name);
    try { if (fs.statSync(d).uid !== uid) continue; } catch { continue; }
    const env = readEnviron(d);
    if (!env || !env.DISPLAY || !/^:\d+(\.\d+)?$/.test(env.DISPLAY)) continue;
    const display = env.DISPLAY.replace(/\.\d+$/, '');
    if (liveDisplays && !liveDisplays.has(display)) continue;
    const key = [display, env.XAUTHORITY || '', env.WAYLAND_DISPLAY || '', env.XDG_RUNTIME_DIR || ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    let comm = '';
    try { comm = fs.readFileSync(path.join(d, 'comm'), 'utf8').trim(); } catch { /* gone */ }
    out.push({ pid: Number(e.name), comm, display, env });
  }
  const sessioniness = (x) => (x.env.WAYLAND_DISPLAY ? 2 : 0) + (x.env.XAUTHORITY ? 1 : 0);
  out.sort((a, b) => sessioniness(b) - sessioniness(a) || b.pid - a.pid);
  return out.slice(0, cap);
}

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

module.exports = { analyzeInput, portCard, PortQueue, selftest, TMP, findLiveDisplays, hasXvfbRun, findProcDisplayPairs, xauthorityCandidates, findSessionEnvs };
