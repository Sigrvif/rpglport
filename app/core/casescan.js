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
const AUDIO_PARENT = { bgm: 'audio/bgm', bgs: 'audio/bgs', me: 'audio/me', se: 'audio/se', battleBgm: 'audio/bgm', victoryMe: 'audio/me', defeatMe: 'audio/me' };
// MV/MZ event commands carry asset names inside flat `parameters` arrays — no
// collectible KEY exists, so the table above alone misses them. Codes verified
// against the stock interpreter: 231 Show Picture (name at parameters[1]),
// 132/133/134 Change Battle BGM / Victory ME / Defeat ME and 241/245/249/250
// Play BGM/BGS/ME/SE (audio object at parameters[0]), 261 Play Movie.
const EVENT_AUDIO_DIRS = { 132: 'audio/bgm', 133: 'audio/me', 134: 'audio/me', 241: 'audio/bgm', 245: 'audio/bgs', 249: 'audio/me', 250: 'audio/se' };
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
      if (typeof node.code === 'number' && Array.isArray(node.parameters)) {
        if (node.code === 231 && typeof node.parameters[1] === 'string' && node.parameters[1]) {
          addImg('img/pictures', node.parameters[1]);
        } else if (node.code === 261 && typeof node.parameters[0] === 'string' && node.parameters[0]) {
          add(`movies/${node.parameters[0]}.webm`);
          add(`movies/${node.parameters[0]}.mp4`);
        } else if (EVENT_AUDIO_DIRS[node.code] && node.parameters[0] && typeof node.parameters[0].name === 'string' && node.parameters[0].name) {
          addAudio(EVENT_AUDIO_DIRS[node.code], node.parameters[0].name);
        }
      }
      for (const [k, v] of Object.entries(node)) visit(v, k, key);
      return;
    }
    if (typeof node === 'string' && node) {
      if (IMG_KEYS[key]) addImg(IMG_KEYS[key], node);
      else if (key === 'name' && AUDIO_PARENT[parentKey]) addAudio(AUDIO_PARENT[parentKey], node);
    }
  };
  for (const f of walkFiles(path.join(payloadRoot, 'data'), n => n.endsWith('.json'))) {
    try { visit(JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')), null, null); }
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
    try { txt = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''); } catch { continue; }
    for (const m of txt.replace(/\\/g, '/').match(LITERAL_RE) || []) add(m);
    // Plugin note-tags that name assets without ever forming an img/ path:
    // Ayatam 歩行グラフィック拡張MVMZ lives in event comments like
    // <acg character: $name, opts> — invisible to the key table (not a data
    // key) and to LITERAL_RE (no img/ prefix). The data's casing is what the
    // game asks for at load time, so it drives the case fixes.
    for (const m of txt.matchAll(/<acg ([a-zA-Z]+):\s*([^,>\n]+?)\s*(?:,[^>]*)?>/g)) {
      if (m[1] === 'character' && m[2]) addImg('img/characters', m[2]);
    }
  }
  return { refCounts, scanErrors };
}

// Base of a lower-cased rel path = dirname + basename without its final
// extension. Extension probing harvests several candidates per base
// (img/faces/Ghost.png/.jpg/.jpeg); missing-reporting groups by this base.
function baseOf(lower) {
  const slash = lower.lastIndexOf('/');
  const dir = slash === -1 ? '' : lower.slice(0, slash);
  const name = slash === -1 ? lower : lower.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot <= 0 ? name : name.slice(0, dot);
  return dir ? `${dir}/${stem}` : stem;
}

function scan(payloadRoot) {
  const { files } = indexTree(payloadRoot);
  const { refCounts, scanErrors } = collectRefs(payloadRoot);

  // Disk bases: every prefix ending just before ANY dot in a file's basename,
  // so "any key starting with dir/base + '.'" is an exact set lookup.
  const diskBases = new Set();
  for (const key of files.keys()) {
    const slash = key.lastIndexOf('/');
    const dir = slash === -1 ? '' : key.slice(0, slash);
    const name = slash === -1 ? key : key.slice(slash + 1);
    let idx = -1;
    while ((idx = name.indexOf('.', idx + 1)) !== -1) {
      const stem = name.slice(0, idx);
      diskBases.add(dir ? `${dir}/${stem}` : stem);
    }
  }

  const duplicates = [], conflicts = [], missing = [];
  const allFixes = [];
  const missingByBase = new Map(); // base → Map(refAsWritten → count)
  for (const [lower, casingMap] of refCounts) {
    const onDisk = files.get(lower);
    if (!onDisk) {
      // A probed candidate with no exact disk match only counts as missing
      // when NO extension-sibling of the same base exists on disk.
      const base = baseOf(lower);
      if (!missingByBase.has(base)) missingByBase.set(base, new Map());
      const agg = missingByBase.get(base);
      for (const [c, n] of casingMap) agg.set(c, (agg.get(c) || 0) + n);
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
    if (canonical !== actual) allFixes.push({ actual, ref: canonical });
    // materialize every referenced casing except the canonical one — including
    // the old disk casing when it was itself referenced (otherwise that
    // reference dangles after the rename)
    for (const c of casingMap.keys()) if (c !== canonical) duplicates.push({ target: canonical, as: c });
  }
  // One missing entry per base: the most-referenced casing across ALL of that
  // base's probed candidates (first-seen wins ties, matching probe order).
  for (const [base, agg] of missingByBase) {
    if (!diskBases.has(base)) continue;                                  // sibling on disk → not missing
    // Encrypted-asset case fix (base has a sibling on disk): MV's Decrypter
    // swaps extensions at load time (.png→.rpgmvp, .ogg→.rpgmvo, .m4a→.rpgmvm)
    // and MZ's weak encryption appends a literal `_` (Bitmap fetches url+"_"
    // when hasEncryptedImages: foo.png → foo.png_) — but references always
    // carry the PLAIN extension, so the exact-match fix above never sees these.
    // Windows loaded them through its case-insensitive open; on Linux the
    // loader's lookup is case-sensitive, so the file must carry the referenced
    // casing.
    const ENC_EXTS = ['.rpgmvp', '.rpgmvo', '.rpgmvm', '.png_', '.jpg_', '.jpeg_', '.ogg_', '.m4a_', '.wav_', '.mp3_', '.webm_', '.webm', '.mp4'];
    const enc = ENC_EXTS.find(e => files.get(base + e)) || null;
    if (!enc) continue;
    const encDisk = files.get(base + enc);
    if (encDisk.length !== 1) { conflicts.push({ files: encDisk }); continue; }
    // stems as referenced (extension stripped), most-referenced wins; ties → keep disk casing
    const stems = new Map();
    for (const [w, n] of agg) {
      const stem = w.slice(0, w.lastIndexOf('.'));
      stems.set(stem, (stems.get(stem) || 0) + n);
    }
    const ranked = [...stems.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const tied = ranked.length > 1 && ranked[0][1] === ranked[1][1];
    const diskStem = encDisk[0].slice(0, encDisk[0].length - enc.length);
    const canonical = (tied ? diskStem : ranked[0][0]) + enc;
    if (canonical !== encDisk[0]) allFixes.push({ actual: encDisk[0], ref: canonical });
    for (const s of stems.keys()) if (s + enc !== canonical) duplicates.push({ target: canonical, as: s + enc });
    continue;
  }
  for (const [base, agg] of missingByBase) {
    if (diskBases.has(base)) continue;                                   // sibling on disk → not missing
    let best = null, bestN = -1;
    for (const [c, n] of agg) if (n > bestN) { best = c; bestN = n; }
    missing.push(best);
  }
  // a fix can be reached twice (exact-match AND an enc-sibling branch when the
  // disk extension itself is a probed candidate, e.g. plain .webm movies)
  const fixes = [...new Map(allFixes.map(f => [`${f.actual}|${f.ref}`, f])).values()];
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

module.exports = { scan, collectRefs, destIsCaseInsensitive };
