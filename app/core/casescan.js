'use strict';
// Case-sensitivity scanner (spec §8.5). Read-only against the game; produces a
// rename/duplicate plan that port.js applies while copying. MV+MZ asset keys.
const fs = require('fs');
const path = require('path');

const IMG_EXTS = ['.png', '.jpg', '.jpeg'];
const AUDIO_EXTS = ['.ogg', '.m4a', '.rpgmvo', '.wav', '.mp3', '.rpgmvw'];
const IMG_KEYS = {
  faceName: 'img/faces', battlerName: 'img/enemies', characterName: 'img/characters',
  pictureName: 'img/pictures', parallaxName: 'img/parallaxes',
  battleback1Name: 'img/battlebacks1', battleback2Name: 'img/battlebacks2',
  tilesetNames: 'img/tilesets', title1Name: 'img/titles1', title2Name: 'img/titles2',
  animations1Name: 'img/animations', animations2Name: 'img/animations',
  systemName: 'img/system', svBattlerName: 'img/sv_actors', svEnemyName: 'img/sv_enemies',
  effectName: 'effects',
};
const AUDIO_PARENT = { bgm: 'audio/bgm', bgs: 'audio/bgs', me: 'audio/me', se: 'audio/se' };
const LITERAL_RE = /(img|audio|movies|effects|fonts)\/[^\s"'`,;()<>[\]\\]+?\.(png|jpe?g|ogg|m4a|rpgmvo|rpgmvw|wav|mp3|mp4|webm|json|ttf|otf|woff2?)/gi;

// Recursive file index: lower(rel) → [actualRels]. Case-distinct siblings on
// disk land in the same bucket — exactly what conflict detection needs.
function indexTree(root) {
  const files = new Map();
  const stack = [{ dir: root, rel: '' }];
  while (stack.length) {
    const { dir, rel } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push({ dir: path.join(dir, e.name), rel: childRel });
      else if (e.isFile()) {
        const lower = childRel.toLowerCase();
        if (!files.has(lower)) files.set(lower, []);
        files.get(lower).push(childRel);
      }
    }
  }
  return { files };
}

function walkFiles(root, want) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && want(e.name)) out.push(p);
    }
  }
  return out;
}

// refCounts: lower(ref) → Map(refAsWritten → count). Two collectors: the MV/MZ
// key table (data/*.json) and a literal path scan (js/, data/, package.json).
function collectRefs(payloadRoot) {
  const refCounts = new Map();
  let scanErrors = 0;
  const add = (ref) => {
    const lower = ref.toLowerCase();
    if (!refCounts.has(lower)) refCounts.set(lower, new Map());
    const m = refCounts.get(lower);
    m.set(ref, (m.get(ref) || 0) + 1);
  };
  const addImg = (dir, name) => { for (const ext of IMG_EXTS) add(`${dir}/${name}${ext}`); };
  const addAudio = (dir, name) => { for (const ext of AUDIO_EXTS) add(`${dir}/${name}${ext}`); };

  // Collector 1: key table. Audio objects are { name, pan, pitch, volume } under
  // a bgm/bgs/me/se key, hence the parentKey tracking.
  const visit = (node, key, parentKey) => {
    if (Array.isArray(node)) {
      if (key === 'tilesetNames') {
        for (const el of node) if (typeof el === 'string' && el) addImg('img/tilesets', el);
      } else {
        for (const el of node) visit(el, key, parentKey);
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) visit(v, k, key);
      return;
    }
    if (typeof node === 'string' && node) {
      if (IMG_KEYS[key]) addImg(IMG_KEYS[key], node);
      else if (key === 'name' && AUDIO_PARENT[parentKey]) addAudio(AUDIO_PARENT[parentKey], node);
    }
  };
  for (const f of walkFiles(path.join(payloadRoot, 'data'), n => n.endsWith('.json'))) {
    try { visit(JSON.parse(fs.readFileSync(f, 'utf8')), null, null); }
    catch { scanErrors++; }
  }

  // Collector 2: literal asset paths in code/config (covers plugins, MZ
  // effects, and backslash-separated Windows paths).
  const literalFiles = [];
  for (const sub of ['js', 'data']) {
    literalFiles.push(...walkFiles(path.join(payloadRoot, sub), n => n.endsWith('.js') || n.endsWith('.json')));
  }
  const pkg = path.join(payloadRoot, 'package.json');
  if (fs.existsSync(pkg) && !literalFiles.includes(pkg)) literalFiles.push(pkg);
  for (const f of literalFiles) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of txt.replace(/\\/g, '/').match(LITERAL_RE) || []) add(m);
  }
  return { refCounts, scanErrors };
}

function scan(payloadRoot) {
  const { files } = indexTree(payloadRoot);
  const { refCounts, scanErrors } = collectRefs(payloadRoot);
  const fixes = [], duplicates = [], conflicts = [], missing = [];
  for (const [lower, casingMap] of refCounts) {
    const onDisk = files.get(lower);
    if (!onDisk) {
      let best = null, bestN = -1;
      for (const [c, n] of casingMap) if (n > bestN) { best = c; bestN = n; }
      missing.push(best);
      continue;
    }
    if (onDisk.length > 1) { conflicts.push({ files: onDisk }); continue; }
    const actual = onDisk[0];
    const others = [...casingMap.keys()].filter(c => c !== actual);
    if (!others.length) continue;
    const ranked = [...casingMap.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const topCount = ranked[0][1];
    const tied = ranked.filter(e => e[1] === topCount).length > 1;
    const canonical = tied ? actual : ranked[0][0];
    if (canonical !== actual) fixes.push({ actual, ref: canonical });
    // materialize every referenced casing except the canonical one — including
    // the old disk casing when it was itself referenced (otherwise that
    // reference dangles after the rename)
    for (const c of casingMap.keys()) if (c !== canonical) duplicates.push({ target: canonical, as: c });
  }
  return {
    fixes, duplicates, conflicts, missing, scanErrors,
    counts: { fixes: fixes.length + duplicates.length, warnings: conflicts.length + missing.length },
  };
}

// Probe the destination for case-insensitive semantics (FAT/exFAT/vfat mounts).
function destIsCaseInsensitive(dir) {
  const d = fs.mkdtempSync(path.join(dir, 'ci-'));
  try {
    fs.writeFileSync(path.join(d, 'Probe'), 'a');
    fs.writeFileSync(path.join(d, 'probe'), 'b');
    return fs.readFileSync(path.join(d, 'Probe'), 'utf8') === 'b';
  } catch {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

module.exports = { scan, destIsCaseInsensitive };
