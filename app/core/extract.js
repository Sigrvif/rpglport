'use strict';
// Archive handling (static 7zz) and game-root resolution for dropped inputs.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Split-volume names (zip.001, 7z.002, part1.rar) need joining before 7zz can
// open them; plain single-file archives are handled directly, so they are null.
// NOTE: the reference implementation returned 'archive' for plain .zip/.7z;
// 'split' for volume sets, 'archive' for plain archives (engine.js branches on
// both), null otherwise.
function archiveKind(name) {
  if (/\.(zip|7z|rar)\.\d+$/i.test(name) || /\.part\d+\.rar$/i.test(name)) return 'split';
  if (/\.(zip|7z|rar)$/i.test(name)) return 'archive';
  return null;
}

function run7zz(bin, args) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', c => { out += c; if (out.length > 2e6) p.kill(); });
    p.stderr.on('data', c => { err += c; if (err.length > 2e6) p.kill(); });
    p.on('error', e => resolve({ code: -1, out, err: String(e) }));
    p.on('close', code => resolve({ code, out, err }));
  });
}

async function testArchive(bin, file) {
  const split = archiveKind(path.basename(file)) === 'split';
  if (split) return { ok: false, split: true, encrypted: false, reason: 'split volume set — finish the download / join first' };
  const r = await run7zz(bin, ['t', '-y', '--', file]);
  if (r.code === 0) return { ok: true, split: false, encrypted: false };
  const blob = r.out + r.err;
  const encrypted = /wrong password|enter password|encrypted/i.test(blob);
  return {
    ok: false, split: false, encrypted,
    reason: encrypted ? 'archive is password-protected' : '7-Zip cannot open this archive',
  };
}

async function extractArchive(bin, file, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = await run7zz(bin, ['x', '-y', `-o${destDir}`, '--', file]);
  return { ok: r.code === 0, stderr: r.err };
}

// A directory is a game root if it looks like a shipped MV/MZ game.
function isGameRoot(dir) {
  const has = p => fs.existsSync(path.join(dir, p));
  if (has('Game.exe') || has('nw.exe')) return true;
  if (has('package.json') && has('www')) return true;
  if (has('index.html') && has('js/rmmz_core.js')) return true;
  return false;
}

function resolveGameRoots(dir, depth = 0) {
  let stat;
  try { stat = fs.statSync(dir); } catch { return []; }
  if (!stat.isDirectory()) return [];
  if (isGameRoot(dir)) return [dir];
  if (depth >= 3) return [];
  let roots = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    roots.push(...resolveGameRoots(path.join(dir, e.name), depth + 1));
  }
  return [...new Set(roots)];
}

module.exports = { archiveKind, testArchive, extractArchive, resolveGameRoots, isGameRoot };
