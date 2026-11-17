'use strict';
// Port builder (spec §8): runtime copy + execstack fix + payload with the
// case-fix plan applied + package.json normalization + start.sh + NOTES.txt.
// Output is assembled in a temp dir and renamed into place atomically.
const fs = require('fs');
const path = require('path');
const { clearExecStack } = require('./elf');
const { destIsCaseInsensitive } = require('./casescan');
const { cmpVer } = require('./detect');
const { USABLE_FLOOR } = require('./select');

const SKIP_EXACT = new Set([
  'icudtl.dat', 'natives_blob.bin', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'credits.html', 'debug.log',
]);
const SKIP_DIRS = new Set(['locales', 'swiftshader']);

// Only names that COLLIDE with the Linux runtime's own files are skipped —
// those must stay the Linux build's (icudtl.dat/V8 snapshots/paks are
// version-locked to the bundled Chromium). Original Windows runtime files
// (*.dll, Game.exe, launcher stubs) are deliberately SHIPPED as inert data:
// games with launcher-integrity DRM hash-check them from their core scripts
// and silently self-exit when they are missing or differ (verified on a
// pool game that hashed libGLESv2.dll and process.exit()ed on mismatch).
// Their presence
// makes such checks pass legitimately; they are never executed on Linux.
function isWinRuntime(name, isDir) {
  const n = name.toLowerCase();
  if (isDir) return SKIP_DIRS.has(n);
  return SKIP_EXACT.has(n) || n.endsWith('.pak');
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
const NW_WRAPPER = '#!/bin/sh\nd="$(cd -- "$(dirname -- "$0")" && pwd)"\nexport FONTCONFIG_FILE="${FONTCONFIG_FILE:-$d/fonts.conf}"\nexport GDK_BACKEND=x11\nexport XDG_CONFIG_HOME="$d/.userdata"\nexport LD_LIBRARY_PATH="$d/lib:$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\nb="$d/nw.bin"\n[ -n "$NW_SUFFIX" ] && [ -x "$d/nw$NW_SUFFIX" ] && b="$d/nw$NW_SUFFIX"\nexec "$b" "$@" --disable-breakpad\n'; // LD_LIBRARY_PATH: belt-and-braces alongside rpath (portable-bundle practice); lib/ modern, $d root for ≤0.12-era flat .so layout
// --disable-breakpad: old breakpad's shutdown path raises SIGSEGV (si_code
// SI_TKILL) in a child at window close — the game exits fine, but the system
// crash reporter pops "nw.bin encountered a fatal error" per close. Verified:
// 3/3 baseline closes crash ("Failed to tell parent about crash" in stderr),
// 3/3 clean with the switch; no other behavior change.
// XDG_CONFIG_HOME: isolate the Chromium profile inside the port. Empty/JP-only
// game names all slugify to one key, so every such port would otherwise share
// ~/.config/<key> — one newer-runtime launch (pool update, re-port, Test Run of
// another game) poisons it and every older runtime then pops
// "Profile Error Occurred ... newer version of NW.js" on each start.
// NW_SUFFIX: per-variant entry point — see the variant launchers below.

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
    const st = fs.statSync(s); // follow symlinks — a dev checkout's host root symlinks lib/ and nw into _host/
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
    // EXCEPT when the runtime IS the tool's own bundle root (dist layout: the
    // host runtime with the app layered on top — build.json marks it): the
    // tool's additive files must not leak into the port. (The dev repo mirrors
    // this via symlinks, but listPool points its host entry at the clean
    // _host/ dir when one exists, so this mainly guards the dist.)
    const TOOL_ROOT_SKIP = new Set([
      'app', 'bin', 'runtimes', 'licenses', 'build.json', 'RPGLPort.sh',
      'README.md', '.git', '.gitignore', 'test', 'tools', 'docs', 'dist',
      '_host', 'src', 'run-dev.sh', '.userdata',
    ]);
    const skipToolRoot = fs.existsSync(path.join(runtimeDir, 'build.json'))
      ? (name) => TOOL_ROOT_SKIP.has(name)
      : null;
    copyTree(runtimeDir, tmp, {
      cancel,
      skip: skipToolRoot,
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
    if (info.detectedNW && cmpVer(info.detectedNW, USABLE_FLOOR) < 0 && cmpVer(runtimeVersion, USABLE_FLOOR) >= 0) {
      notes.push(`native runtime ${info.detectedNW} not shipped: NW.js older than ${USABLE_FLOOR} never opens a window on modern Linux (the browser idles forever before spawning its renderer), so this port uses ${runtimeVersion}`);
    }
    if (cmpVer(runtimeVersion, '0.30.0') < 0 && fs.existsSync(path.join(tmp, 'nw'))) {
      fs.writeFileSync(path.join(tmp, 'fonts.conf'), FONTCONFIG_CONF);
      fs.renameSync(path.join(tmp, 'nw'), path.join(tmp, 'nw.bin'));
      fs.writeFileSync(path.join(tmp, 'nw'), NW_WRAPPER);
      fs.chmodSync(path.join(tmp, 'nw'), 0o755);
      notes.push(`fontconfig workaround: old runtime ${runtimeVersion} cannot parse modern fontconfig; nw wrapper pins FONTCONFIG_FILE to the bundled fonts.conf`);
      notes.push('breakpad disabled: old crash handler raises SIGSEGV in a child at exit (harmless to the game, but every close popped a system crash-reporter notice)');
    }

    // 1c) Legacy lib set for runtimes < 0.29 (GTK2/Chromium-41 era): they hard-
    // link libgconf-2.so.4, libgtk-x11-2.0.so.0, libgdk-x11-2.0.so.0 and (≤0.12)
    // libnotify.so.4, with libdbus-glib-1 for gconf — every one dropped by
    // modern distros. Vendored Debian buster builds (glibc 2.28 = documented
    // floor), closure verified by ldd against the pool's 0.12.3/0.19.5/0.22.3.
    // They land in the port root, which every launcher's LD_LIBRARY_PATH covers.
    if (cmpVer(runtimeVersion, '0.29.0') < 0) {
      const compatDir = path.join(__dirname, '..', 'compat', 'legacy-libs');
      if (fs.existsSync(compatDir)) {
        for (const f of fs.readdirSync(compatDir)) {
          const src = path.join(compatDir, f);
          if (f.startsWith('copyright-')) {
            fs.mkdirSync(path.join(tmp, 'licenses', 'legacy-libs'), { recursive: true });
            fs.copyFileSync(src, path.join(tmp, 'licenses', 'legacy-libs', f));
          } else if (fs.lstatSync(src).isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(src), path.join(tmp, f));
          } else {
            fs.copyFileSync(src, path.join(tmp, f));
          }
        }
        notes.push('legacy libs bundled: GTK2-era set (libgconf-2, libgtk-x11-2.0, libgdk-x11-2.0, libnotify.so.4, libdbus-glib-1) — dropped by modern distros, required by runtimes < 0.29 (licenses in licenses/legacy-libs)');
      } else {
        warnings.push('legacy lib set missing (app/compat/legacy-libs) — this old runtime will fail to load on modern distros without libgconf/GTK2');
      }
    }

    // Extra root executables (multi-language / variant distributions):
    // byte-identical stubs WITH a _<suffix> name are the RPG-Maker multi-
    // language pattern — the game (title-map event script) reads
    // path.parse(process.execPath).name and switches on the suffix
    // (verified: exeName.slice(-2) → _E/_C/_T → LANGUAGE). Identical bytes
    // behave differently purely through the launched name, so the port
    // mirrors them: hardlink nw_<S> (same inode, zero disk) + start-<S>.sh.
    // Differing exes are Windows-only tools/variants — warn, don't hide.
    const variants = [];
    for (const x of info.extraExes || []) {
      const m = x.identical ? x.name.match(/^(.*)_([A-Za-z0-9]{1,8})\.exe$/i) : null;
      if (m) {
        const s = m[2];
        if (!variants.includes(s)) variants.push(s);
      } else if (x.identical) {
        notes.push(`extra executable ${x.name}: byte-identical to Game.exe (branding stub — covered by this port)`);
      } else {
        warnings.push(`extra executable ${x.name} differs from Game.exe — shipped as inert data (Windows-only, not runnable here)`);
      }
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

    // 3b) Launcher-integrity DRM detector: some games hash-check files of the
    // ORIGINAL Windows runtime (or of Game.exe) from their core manager
    // scripts and silently process.exit() when the check fails. Core scripts
    // never legitimately call process.exit, so its presence there is a strong,
    // cheap signal. The original runtime files are shipped (see isWinRuntime),
    // which makes such checks pass on Linux; the note documents why they are
    // there in case a check targets something exotic we cannot anticipate.
    const coreScripts = info.engine === 'MZ'
      ? ['js/rmmz_core.js', 'js/rmmz_managers.js', 'js/rmmz_objects.js', 'js/rmmz_scenes.js']
      : ['www/js/rpg_core.js', 'www/js/rpg_managers.js', 'www/js/rpg_objects.js', 'www/js/rpg_scenes.js'];
    for (const rel of coreScripts) {
      const f = path.join(tmp, rel);
      try {
        if (fs.readFileSync(f, 'utf8').includes('process.exit')) {
          notes.push(`launcher-integrity self-check detected (${rel} calls process.exit): the original Windows runtime files are bundled at the port root so the check passes on Linux — do not delete them`);
          break;
        }
      } catch { /* absent */ }
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
    // Games are X11 apps: pin GDK_BACKEND so a Wayland-session parent that
    // exports GDK_BACKEND=wayland (which old-NW GTK lacks entirely — it dies
    // with "cannot open display" regardless of X credentials) cannot break
    // the launch. Standard recipe for X11 GTK apps under Wayland sessions.
    // Variant selection (NW_SUFFIX) lives in exactly ONE place per era: the
    // nw wrapper for old runtimes (start.sh must exec the wrapper to get the
    // fontconfig env — never nw_<S> directly), start.sh itself for modern
    // runtimes (no wrapper exists).
    const oldRT = fs.existsSync(path.join(tmp, 'nw.bin'));
    fs.writeFileSync(path.join(tmp, 'start.sh'), oldRT
      ? '#!/bin/sh\nd="$(cd -- "$(dirname -- "$0")" && pwd)"\nexport GDK_BACKEND=x11\nexport XDG_CONFIG_HOME="$d/.userdata"\nexport LD_LIBRARY_PATH="$d/lib:$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\nexec "$d/nw" "$@"\n'
      : '#!/bin/sh\nd="$(cd -- "$(dirname -- "$0")" && pwd)"\nexport GDK_BACKEND=x11\nexport XDG_CONFIG_HOME="$d/.userdata"\nexport LD_LIBRARY_PATH="$d/lib:$d${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\nb="$d/nw"\n[ -n "$NW_SUFFIX" ] && [ -x "$d/nw$NW_SUFFIX" ] && b="$d/nw$NW_SUFFIX"\nexec "$b" "$@"\n'); // LD_LIBRARY_PATH: belt-and-braces alongside rpath — don't rely on $ORIGIN alone; XDG_CONFIG_HOME: port-local profile (see NW_WRAPPER note)
    fs.chmodSync(path.join(tmp, 'start.sh'), 0o755);

    // 5b) Variant launchers mirroring the game's extra executables (the
    // multi-language pattern: execPath suffix selects the language). The
    // suffixed binary is a HARDLINK of the runtime binary — same inode, no
    // extra disk — so process.execPath ends in _<suffix> exactly like
    // Game_<suffix>.exe did on Windows. All env (fontconfig wrapper for old
    // runtimes, GDK/XDG/LD) still applies: start-<S>.sh re-enters start.sh
    // with NW_SUFFIX set.
    const binName = fs.existsSync(path.join(tmp, 'nw.bin')) ? 'nw.bin' : 'nw';
    for (const s of variants) {
      try {
        fs.linkSync(path.join(tmp, binName), path.join(tmp, `nw_${s}`));
        fs.writeFileSync(path.join(tmp, `start-${s}.sh`), `#!/bin/sh\nd="$(cd -- "$(dirname -- "$0")" && pwd)"\nNW_SUFFIX=_${s} exec "$d/start.sh" "$@"\n`);
        fs.chmodSync(path.join(tmp, `start-${s}.sh`), 0o755);
        notes.push(`variant launcher start-${s}.sh: runs the runtime as nw_${s} (mirrors the game's ${info.extraExes.find(x => x.identical && x.name.endsWith('_' + s + '.exe')).name} — needed when the game selects language/variant by executable name)`);
      } catch (e) {
        warnings.push(`could not create variant launcher start-${s}.sh (${e.code || e.message}) — hardlinks unsupported on the destination filesystem?`);
      }
    }
    // real credits over the runtime's sample placeholder page (shared ports
    // are public artifacts — attribution should be accurate)
    try {
      fs.copyFileSync(path.join(__dirname, '..', 'credits-template.html'), path.join(tmp, 'credits.html'));
    } catch { /* dev tree without template — runtime's own file stays */ }
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
      'profile: isolated in .userdata/ next to start.sh (launch via start.sh so it applies)',
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
