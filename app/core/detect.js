'use strict';
// Game analysis: layout signature, engine version, NW.js version detection
// (confidence ladder), Enigma packed-exe flag. Read-only: never modifies the game.
const fs = require('fs');
const path = require('path');
const { readPE, nodeStamps, chromeStamps, isEnigmaPacked } = require('./pe');
const nwmap = require('./nwmap.json');

const cmpVer = (a, b) => {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
};

function readEngineVersion(jsPath) {
  try {
    const txt = fs.readFileSync(jsPath, 'utf8').slice(0, 400000);
    const m = txt.match(/RPGMAKER_VERSION\s*=\s*"([\d.]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

function layoutOf(dir) {
  const has = p => fs.existsSync(path.join(dir, p));
  if ((has('package.json') || has('Game.exe') || has('nw.exe')) && has('www/index.html')) return 'MV';
  if (has('index.html') && has('js/rmmz_core.js')) return 'MZ';
  return null;
}

function analyze(dir) {
  const evidence = [], flags = [];
  let engine = layoutOf(dir);
  let engineVersion = null;
  let detectedNW = null, arch = null;
  let payloadRoot = null, packageJsonPath = null;

  if (engine === 'MV') {
    engineVersion = readEngineVersion(path.join(dir, 'www/js/rpg_core.js'));
    payloadRoot = path.join(dir, 'www');
    packageJsonPath = path.join(dir, 'package.json');
  } else if (engine === 'MZ') {
    engineVersion = readEngineVersion(path.join(dir, 'js/rmmz_core.js'));
    payloadRoot = dir;
    packageJsonPath = path.join(dir, 'package.json');
  }

  // Binary stamps (authoritative). Browser-process files outrank node modules.
  // PE version stamps are read from ALL FOUR files (the MZ fixtures' node.dll
  // carries `0.44.0-beta1` as a PE resource, with no node.js/v string inside);
  // bare full chromium versions live in Game.exe/nw.dll; node.js/v strings in
  // MV's node.dll.
  const browser = [], nodeMods = [];
  for (const f of ['Game.exe', 'nw.exe', 'nw.dll']) {
    try {
      const buf = fs.readFileSync(path.join(dir, f));
      const pe = readPE(buf);
      if (!pe) continue;
      if (pe.arch) arch = pe.arch;
      if (isEnigmaPacked(pe)) flags.push('enigma');
      for (const v of pe.stamps) browser.push({ src: f, kind: 'nw', value: v });
      for (const c of chromeStamps(buf).fulls) if (nwmap.byChromium[c]) browser.push({ src: f, kind: 'chromium', value: c });
    } catch { /* absent */ }
  }
  for (const f of ['node.dll', 'nw_elf.dll']) {
    try {
      const buf = fs.readFileSync(path.join(dir, f));
      const pe = readPE(buf);
      if (pe) for (const v of pe.stamps) nodeMods.push({ src: f, kind: 'nw', value: v });
      for (const n of nodeStamps(buf)) nodeMods.push({ src: f, kind: 'node', value: n });
      for (const c of chromeStamps(buf).fulls) if (nwmap.byChromium[c]) nodeMods.push({ src: f, kind: 'chromium', value: c });
    } catch { /* absent */ }
  }
  evidence.push(...browser, ...nodeMods);

  // detectedNW resolution ladder: browser NW stamps → node-module NW stamps →
  // node.js strings → chromium full versions (either tier)
  const allNW = [...browser, ...nodeMods].filter(e => e.kind === 'nw' && nwmap.versions[e.value])
    .sort((a, b) => cmpVer(b.value, a.value));
  if (allNW.length) {
    detectedNW = allNW[0].value;
  } else {
    const nodes = [...browser, ...nodeMods].filter(e => e.kind === 'node').sort((a, b) => cmpVer(b.value, a.value));
    const nodeHit = nodes.find(n => nwmap.byNode[n.value]);
    if (nodeHit) detectedNW = nwmap.byNode[nodeHit.value];
    else {
      const chs = [...browser, ...nodeMods].filter(e => e.kind === 'chromium')
        .sort((a, b) => cmpVer(nwmap.byChromium[b.value], nwmap.byChromium[a.value]));
      if (chs.length) detectedNW = nwmap.byChromium[chs[0].value];
    }
  }

  if (fs.existsSync(path.join(dir, 'app.nw'))) flags.push('app-nw');
  if (!engine) flags.push('not-rpgmaker');
  if (engine && packageJsonPath && !fs.existsSync(packageJsonPath)) flags.push('missing-package-json');

  return { engine: engine, engineVersion, detectedNW, evidence, flags, arch, payloadRoot, packageJsonPath };
}

module.exports = { analyze, layoutOf, cmpVer };
