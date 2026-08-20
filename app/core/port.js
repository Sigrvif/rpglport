'use strict';
// Port builder (spec §8): runtime copy + execstack fix + payload with the
// case-fix plan applied + package.json normalization + start.sh + NOTES.txt.
// Output is assembled in a temp dir and renamed into place atomically.
const fs = require('fs');
const path = require('path');
const { clearExecStack } = require('./elf');
const { destIsCaseInsensitive } = require('./casescan');
const { cmpVer } = require('./detect');

const SKIP_EXACT = new Set([
  'game.exe', 'nw.exe', 'game.bin', 'notification_helper.exe', 'icudtl.dat',
  'natives_blob.bin', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'credits.html', 'debug.log',
]);
const SKIP_DIRS = new Set(['locales', 'swiftshader']);

// Windows-only leftovers of a shipped game have no business in the Linux port.
function isWinRuntime(name, isDir) {
  const n = name.toLowerCase();
  if (isDir) return SKIP_DIRS.has(n);
  return SKIP_EXACT.has(n) || n.endsWith('.dll') || n.endsWith('.pak');
}

// Pre-0.30 NW.js bundles an ancient fontconfig that cannot parse modern
// system configs (new constants, xsi:nil) nor `~`/prefix= cache paths, and
// aborts in InitDefaultFont(); those runtimes get a minimal fonts.conf with
// an absolute writable cachedir, pinned via FONTCONFIG_FILE (spec §6).
const FONTCONFIG_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/usr/share/fonts</dir>
  <dir>~/.local/share/fonts</dir>
  <cachedir>/tmp/rpglport-fontcache</cachedir>
  <alias><family>sans-serif</family><prefer>
    <family>DejaVu Sans</family><family>Noto Sans</family><family>Noto Sans CJK JP</family>
  </prefer></alias>
  <alias><family>serif</family><prefer>
    <family>DejaVu Serif</family><family>Noto Serif</family><family>Noto Serif CJK JP</family>
  </prefer></alias>
  <alias><family>monospace</family><prefer>
    <family>DejaVu Sans Mono</family><family>Noto Sans Mono</family><family>Noto Sans Mono CJK JP</family>
  </prefer></alias>
</fontconfig>
`;
// d must be ABSOLUTE: old fontconfig silently ignores a relative
// FONTCONFIG_FILE and falls back to the (unparseable) system config, which
// aborts with InitDefaultFont(). Relative $0 happens on `./nw`, and via
// start.sh's `exec ./nw "$@"`.
const NW_WRAPPER = '#!/bin/sh\nd="$(cd -- "$(dirname -- "$0")" && pwd)"\nexport FONTCONFIG_FILE="${FONTCONFIG_FILE:-$d/fonts.conf}"\nexec "$d/nw.bin" "$@"\n';

function slugify(name) {
  const s = name.normalize('NFKD').replace(/[^\w\s.-]/g, '').trim()
    .replace(/[\s_.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return s || 'rpgl-port-game';
}

function copyTree(src, dst, { onFile, cancel, skip } = {}) {
  let files = 0, bytes = 0;
  const stack = [{ s: src, d: dst }];
  while (stack.length) {
    if (cancel && cancel.cancelled) throw new Error('cancelled by user');
    const { s, d } = stack.pop();
    const st = fs.lstatSync(s);
    if (st.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      for (const e of fs.readdirSync(s)) {
        if (skip && skip(e, true)) continue;
        stack.push({ s: path.join(s, e), d: path.join(d, e) });
      }
    } else {
      if (skip && skip(path.basename(s), false)) continue;
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      files++;
      bytes += st.size;
      if (onFile) onFile({ files, bytes });
    }
  }
  return { files, bytes };
}

function walkPayload(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      out.push({ rel: childRel, abs: path.join(abs, e.name), isDir: e.isDirectory() });
      if (e.isDirectory()) stack.push(childRel);
    }
  }
  return out;
}

async function buildPort(opts) {
  const { gameDir, info, scan, runtimeDir, outParent, dirName } = opts;
  const onExists = opts.onExists || 'refuse';
  const cancel = opts.cancel;
  const notes = [], warnings = [];

  fs.mkdirSync(outParent, { recursive: true });
  const ci = destIsCaseInsensitive(outParent);
  if (ci) warnings.push('destination filesystem is case-INSENSITIVE: case fixes become no-ops there');

  if (ci && scan.conflicts.length) {
    throw new Error('case-only-distinct asset files cannot be represented on a case-insensitive destination; resolve the conflicts or pick another output location');
  }

  let finalDir = path.join(outParent, dirName);
  if (fs.existsSync(finalDir)) {
    if (onExists === 'refuse') throw new Error(`output exists: ${finalDir}`);
    // overwrite defers deletion of the old port until the new one is fully
    // built in tmp — a failed build must not destroy the previous output
    if (onExists !== 'overwrite') {
      let n = 2;
      while (fs.existsSync(`${finalDir}-${n}`)) n++;
      finalDir = `${finalDir}-${n}`;
    }
  }

  const tmp = path.join(outParent, `.tmp-${slugify(dirName)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    // 1) Runtime — complete, full-fidelity copy. Chromium needs icudtl.dat,
    // locales/, *.pak, swiftshader/ etc. at run time; nothing may be stripped.
    copyTree(runtimeDir, tmp, {
      cancel,
      onFile: ({ files, bytes }) => { if (opts.onProgress) opts.onProgress({ stage: 'runtime', files, bytes }); },
    });
    for (const exe of ['nw', 'crashpad_handler', 'chrome_crashpad_handler']) {
      if (fs.existsSync(path.join(tmp, exe))) fs.chmodSync(path.join(tmp, exe), 0o755);
    }
    const soDirs = [path.join(tmp, 'lib'), tmp];
    for (const dir of soDirs) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase().endsWith('.so')) {
          const f = path.join(dir, e.name);
          if (clearExecStack(f)) notes.push(`cleared executable stack flag: ${path.relative(tmp, f)}`);
        }
      }
    }

    // 1b) Fontconfig workaround for old runtimes: real binary becomes nw.bin,
    // nw becomes a wrapper exporting FONTCONFIG_FILE. Every entry point
    // (start.sh, Test Run, direct ./nw) goes through the wrapper.
    // Gate on the selected runtime version (opts), not the directory name —
    // renamed/copied runtime dirs must not disable the workaround.
    const runtimeVersion = opts.runtimeVersion || (path.basename(runtimeDir).match(/nwjs-v(\d+\.\d+\.\d+)/) || [])[1] || '999.0.0';
    if (cmpVer(runtimeVersion, '0.30.0') < 0 && fs.existsSync(path.join(tmp, 'nw'))) {
      fs.writeFileSync(path.join(tmp, 'fonts.conf'), FONTCONFIG_CONF);
      fs.renameSync(path.join(tmp, 'nw'), path.join(tmp, 'nw.bin'));
      fs.writeFileSync(path.join(tmp, 'nw'), NW_WRAPPER);
      fs.chmodSync(path.join(tmp, 'nw'), 0o755);
      notes.push(`fontconfig workaround: old runtime ${runtimeVersion} cannot parse modern fontconfig; nw wrapper pins FONTCONFIG_FILE to the bundled fonts.conf`);
    }

    // 2) Game payload with the case-fix plan applied (renames at copy time).
    // MV walks the whole game root so root-level extras (readme.txt, save
    // folders, ...) ship too; the plan is payloadRoot-relative, so it applies
    // only under www/. MZ's payload root IS the game root: plan everywhere.
    const relPrefix = path.relative(gameDir, info.payloadRoot);   // MV: 'www', MZ: ''
    const prefixParts = relPrefix.split(path.sep).filter(Boolean);
    const rename = new Map(scan.fixes.map(f => [f.actual.toLowerCase(), f.ref]));
    for (const entry of walkPayload(gameDir)) {
      if (cancel && cancel.cancelled) throw new Error('cancelled by user');
      const name = entry.rel.slice(entry.rel.lastIndexOf('/') + 1);
      if (isWinRuntime(name, entry.isDir)) continue;               // Windows leftovers of the shipped game
      const parts = entry.rel.split('/');
      const inPayload = prefixParts.length === 0
        || parts.slice(0, prefixParts.length).join('/') === relPrefix;
      if (!inPayload) {
        // MV extra outside www/: verbatim (root package.json is normalized later).
        if (!entry.isDir && parts.length === 1 && name === 'package.json') continue;
        const dst = path.join(tmp, entry.rel);
        if (entry.isDir) fs.mkdirSync(dst, { recursive: true });
        else {
          if (fs.existsSync(dst)) continue;                        // runtime files win at their own level
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(entry.abs, dst);
          if (opts.onProgress) opts.onProgress({ stage: 'payload', files: 1, bytes: fs.statSync(entry.abs).size });
        }
        continue;
      }
      const rel = prefixParts.length ? parts.slice(prefixParts.length).join('/') : entry.rel;
      if (!rel) continue;                                          // the payloadRoot dir itself (MV www/)
      const dstRel = rename.get(rel.toLowerCase()) || rel;
      const dst = path.join(tmp, relPrefix, dstRel);
      if (entry.isDir) { fs.mkdirSync(dst, { recursive: true }); continue; }
      if (prefixParts.length === 0 && rel === 'package.json') continue; // normalized below
      if (fs.existsSync(dst)) continue;                            // runtime files win at their own level
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(entry.abs, dst);
      if (opts.onProgress) opts.onProgress({ stage: 'payload', files: 1, bytes: fs.statSync(entry.abs).size });
    }
    if (prefixParts.length) fs.mkdirSync(path.join(tmp, relPrefix), { recursive: true });

    // 3) Minority casings → hard-link (fallback copy) beside the canonical file.
    for (const d of scan.duplicates) {
      if (ci) { warnings.push(`case-insensitive destination: skipped duplicate ${d.as}`); continue; }
      const target = path.join(tmp, relPrefix, d.target);
      const as = path.join(tmp, relPrefix, d.as);
      fs.mkdirSync(path.dirname(as), { recursive: true });
      try { fs.linkSync(target, as); } catch { fs.copyFileSync(target, as); }
      notes.push(`materialized duplicate casing: ${d.as}`);
    }

    // 4) Normalized package.json.
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(gameDir, 'package.json'), 'utf8')); }
    catch { notes.push('synthesized package.json (missing or malformed)'); }
    pkg = pkg || {};
    const baseName = dirName.replace(/\s*\(Linux\)\s*$/, '');
    const out = {
      name: slugify(baseName),
      main: pkg.main || (info.engine === 'MV' ? 'www/index.html' : 'index.html'),
      window: pkg.window || {},
    };
    if (pkg['js-flags']) out['js-flags'] = pkg['js-flags'];
    if (pkg['chromium-args']) out['chromium-args'] = pkg['chromium-args'];
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(out, null, 2));

    // 5) Launcher + notes.
    fs.writeFileSync(path.join(tmp, 'start.sh'), '#!/bin/sh\ncd "$(dirname "$0")"\nexec ./nw "$@"\n');
    fs.chmodSync(path.join(tmp, 'start.sh'), 0o755);
    const lines = [
      'RPGLPort — generated Linux port',
      `runtime: ${path.basename(runtimeDir)}`,
      `detected: ${info.detectedNW || 'unknown'}`,
      ...notes.map(n => `note: ${n}`),
      ...warnings.map(w => `warning: ${w}`),
      ...scan.fixes.map(f => `case fix: ${f.actual} -> ${f.ref}`),
      ...scan.duplicates.map(d => `case duplicate: ${d.as} (from ${d.target})`),
      ...scan.missing.map(m => `missing asset: ${m}`),
      'known issues:',
      '- MV core < 1.6.0 on Chromium 66+: BGM may stay silent until first click',
      '- NW.js ships no H.264/AAC: .m4a-only games have no audio (use .ogg)',
      '- runtime-constructed asset paths cannot be case-checked — run the game once',
    ];
    fs.writeFileSync(path.join(tmp, 'NOTES.txt'), `${lines.join('\n')}\n`);

    if (onExists === 'overwrite') fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmp, finalDir);
    return { finalDir, notes, warnings };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

module.exports = { buildPort, slugify, isWinRuntime, SKIP_EXACT };
