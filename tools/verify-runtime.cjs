#!/usr/bin/env node
// Verify an extracted runtime dir for pool admission (spec §3.3).
// Usage: node tools/verify-runtime.cjs <runtime-dir> [--allow-unnamed]
const { runtimeStamps } = require('../app/core/elf.js');
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const allowUnnamed = process.argv.includes('--allow-unnamed');
const nwmap = require('../app/core/nwmap.json');
const st = runtimeStamps(dir);
const m = path.basename(dir).match(/nwjs-v(\d+\.\d+\.\d+)/);
const problems = [];
if (!st.ok) problems.push('no nw/libnw.so');
if (st.arch !== process.arch) problems.push(`arch ${st.arch} ≠ ${process.arch}`);
if (m) {
  const expect = nwmap.versions[m[1]];
  if (!expect) problems.push(`unknown version ${m[1]}`);
  else if (st.nodes.length && !st.nodes.includes(expect.node)) problems.push(`node mismatch: want ${expect.node}, got ${st.nodes.join(',')}`);
} else if (!allowUnnamed) problems.push('unnamed runtime dir (need nwjs-vX.Y.Z name or --allow-unnamed)');
if (problems.length) { console.error(problems.join('; ')); process.exit(1); }
console.log(`ok ${m ? m[1] : '(unnamed)'} arch=${st.arch} node=${st.nodes[0] || '(name-derived)'}`);
