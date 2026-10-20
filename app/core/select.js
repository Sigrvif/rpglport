'use strict';
// Runtime pool discovery + selection policy (spec §3.3, §6).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runtimeStamps } = require('./elf');
const nwmap = require('./nwmap.json');
const { cmpVer } = require('./detect');

const MZ_FLOOR = '0.44.0';
// NW.js releases below this floor do not open a window on modern Linux.
// Verified on Arch 2026 (boot lab + gdb, kernel shared with user machines):
// ≤ 0.29-era browsers reach an idle GTK main loop and NEVER spawn a renderer —
// the process stays alive with no window and no output — while 0.22.3
// segfaults on launch and 0.39.3 loads pages but its WebGL context never
// initializes. Selection therefore never ships them (fall forward instead);
// a manual override can still force one for experiments.
const USABLE_FLOOR = '0.48.4';
const IMPORT_DIR = () => path.join(os.homedir(), '.cache', 'rpglport', 'runtimes');

function chromeMajorOf(version) {
  const c = nwmap.versions[version] && nwmap.versions[version].chromium;
  return c ? parseInt(c.split('.')[0], 10) : null;
}

function admit(dir, source) {
  const name = path.basename(dir);
  const m = name.match(/nwjs-v(\d+\.\d+\.\d+)/);
  const declared = m ? m[1] : null;
  const st = runtimeStamps(dir);
  if (!st.ok) return { name, reason: 'no nw / lib/libnw.so found' };
  if (st.arch !== process.arch) return { name, reason: `arch ${st.arch} ≠ host ${process.arch} (excluded on this build)` };
  let version = declared;
  if (!version) {
    const n = st.nodes.slice().sort((a, b) => cmpVer(b, a)).find(x => nwmap.byNode[x]);
    version = n ? nwmap.byNode[n] : null;
  }
  if (!version) {
    // modern runtimes carry no node.js/v string (their node stamp moved into
    // v8 snapshots) but libnw.so still advertises `Chrome/<major>.` — use it
    const c = st.chromes.slice().sort((a, b) => cmpVer(nwmap.byChromium[b] || '0.0.0', nwmap.byChromium[a] || '0.0.0'))[0];
    version = c && nwmap.byChromium[c] ? nwmap.byChromium[c] : null;
  }
  if (!version) return { name, reason: 'could not determine NW.js version from stamps or name' };
  if (declared && nwmap.versions[declared]) {
    const expectNode = nwmap.versions[declared].node;
    if (st.nodes.length && !st.nodes.includes(expectNode)) {
      return { name, reason: `name says ${declared} (node ${expectNode}) but binaries say node ${st.nodes.join(',')}` };
    }
  }
  return {
    entry: { version, path: dir, source, node: st.nodes[0] || null, chromiumMajor: chromeMajorOf(version) },
  };
}

function listPool(bundleRoot) {
  const pool = [], rejected = [];
  const tryAdmit = (dir, source) => {
    const r = admit(dir, source);
    r.entry ? pool.push(r.entry) : rejected.push({ name: r.name, reason: r.reason });
  };
  // Host entry: prefer the clean runtime dir of a dev checkout (_host/) over
  // the app root itself — the root only mirrors nw/lib via symlinks and lacks
  // the rest of the runtime (paks, icudtl.dat, locales). In a dist bundle the
  // root IS the host runtime, so it is admitted directly (buildPort skips the
  // tool's additive files there — see TOOL_ROOT_SKIP).
  const hostDir = fs.existsSync(path.join(bundleRoot, '_host', 'nw'))
    ? path.join(bundleRoot, '_host')
    : bundleRoot;
  tryAdmit(hostDir, 'host');
  for (const base of [path.join(bundleRoot, 'runtimes'), IMPORT_DIR()]) {
    if (!fs.existsSync(base)) continue;
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (e.isDirectory()) tryAdmit(path.join(base, e.name), base === IMPORT_DIR() ? 'imported' : 'bundled');
    }
  }
  pool.sort((a, b) => cmpVer(a.version, b.version));
  return { pool, rejected };
}

function choose(poolIn, detectedNW, engine, engineVersion, override) {
  const pool = [...poolIn].sort((a, b) => cmpVer(a.version, b.version)); // defensive: never trust caller order
  const notes = [], warnings = [];
  if (!pool.length) return { runtime: null, notes, warnings, refused: 'no usable runtimes in the pool' };
  // Legacy runtimes are invisible to automatic selection; only a manual
  // override can pick one (exported as nw_<S> variants keep working there).
  const usable = override ? pool : pool.filter(p => cmpVer(p.version, USABLE_FLOOR) >= 0);
  if (!usable.length) {
    return { runtime: null, notes, warnings, refused: `every runtime in the pool is older than ${USABLE_FLOOR} — NW.js that old never opens a window on modern Linux (renderer never spawns); import at least nwjs-v${USABLE_FLOOR}-linux-x64` };
  }
  const legacy = detectedNW && cmpVer(detectedNW, USABLE_FLOOR) < 0;
  let runtime = null;
  if (override) {
    runtime = usable.find(p => p.version === override) || null;
    if (!runtime) return { runtime: null, notes, warnings, refused: `override runtime ${override} not in pool` };
    notes.push(`manual override: ${override}`);
  } else if (detectedNW && usable.some(p => p.version === detectedNW)) {
    runtime = usable.find(p => p.version === detectedNW);
    notes.push(`exact match ${detectedNW}`);
  } else {
    const newer = usable.filter(p => !detectedNW || cmpVer(p.version, detectedNW) > 0);
    if (legacy) {
      // Native era is below the usability floor, so era-fidelity is already
      // lost — ship the NEWEST usable runtime. Modern Chromium's present path
      // also fixes the XWayland vsync/stall/tear problems that plague 0.48-era
      // runtimes on Wayland desktops (user-verified on radeonsi: cutscenes and
      // timing break on 0.48.4, work on 0.115.0).
      runtime = usable[usable.length - 1];
      notes.push(`native ${detectedNW} is below the ${USABLE_FLOOR} usability floor; shipping the newest usable runtime ${runtime.version}`);
    } else if (newer.length) {
      runtime = newer[0];
      if (detectedNW) {
        notes.push(`exact ${detectedNW} not in pool; using nearest newer ${runtime.version}`);
      } else notes.push(`no version detected; using newest ${runtime.version}`);
    } else {
      // nothing usable is ≥ the detected version: the fallback to the newest
      // usable entry is a DOWNGRADE vs what the game shipped with
      runtime = usable[usable.length - 1];
      notes.push(`no runtime ≥ detected ${detectedNW} in pool; DOWNGRADING to newest available ${runtime.version}`);
      warnings.push(`downgrade from detected ${detectedNW} to ${runtime.version}: older Chromium than the game shipped with — test thoroughly`);
    }
  }
  if (legacy && !override) {
    notes.push(`detected ${detectedNW} is below the ${USABLE_FLOOR} usability floor — NW.js that old never opens a window on modern Linux; shipping ${runtime.version} instead`);
  }
  if (engine === 'MZ' && cmpVer(runtime.version, MZ_FLOOR) < 0) {
    return { runtime: null, notes, warnings, refused: `MZ needs NW.js >= ${MZ_FLOOR} (Chromium 80+); ${runtime.version} is too old — import a newer runtime` };
  }
  const cm = runtime.chromiumMajor;
  if (engine === 'MV' && engineVersion && cmpVer(engineVersion + '.0', '1.6.0') < 0 && cm !== null && cm >= 66) {
    warnings.push('MV core < 1.6.0 on Chromium 66+: autoplay policy — BGM may stay silent until first click');
  }
  const dm = detectedNW && chromeMajorOf(detectedNW);
  if (dm !== null && cm !== null && cm - dm >= 10) {
    warnings.push(`big Chromium jump (${dm} → ${cm}): test old plugins`);
  }
  if (cmpVer(runtime.version, '0.29.1') <= 0) {
    warnings.push('old runtime (≤ 0.29 era): possible new-glibc/fontconfig quirks; run the port\'s Test Run');
  }
  return { runtime, notes, warnings, refused: null };
}

module.exports = { listPool, choose, chromeMajorOf, USABLE_FLOOR };
