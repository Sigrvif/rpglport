#!/usr/bin/env node
// Generate app/core/nwmap.json from nwjs.io versions.json.
// Usage: node tools/gen-nwmap.js [versions.json path]
'use strict';
const fs = require('fs');
const path = require('path');
const src = process.argv[2] || path.join(__dirname, 'versions.json');
const out = path.join(__dirname, '..', 'app', 'core', 'nwmap.json');
const all = JSON.parse(fs.readFileSync(src, 'utf8')).versions;
const versions = {};
for (const v of all) versions[v.version.replace(/^v/, '')] = {
  node: v.components.node, chromium: v.components.chromium,
};
// reverse maps: STABLE releases only (betas lose), iterated OLD → NEW so the
// newest stable NW wins for shared components
const byNode = {}, byChromium = {};
for (const v of Object.keys(versions).filter(v => !/-(?:beta|rc|canary)/i.test(v)).sort((a, b) => cmp(a, b))) {
  const { node, chromium } = versions[v];
  byNode[node] = v;
  byChromium[chromium] = v;
  byChromium[chromium.split('.')[0]] = v;
}
function cmp(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), versions, byNode, byChromium }, null, 1));
console.log('wrote', out, `(${Object.keys(versions).length} versions)`);
