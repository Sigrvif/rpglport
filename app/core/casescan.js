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

// refCounts: lower(ref) → Map(refAsWritten → count). Collectors: the MV/MZ
// key table (data/*.json), a literal path scan (js/, data/, package.json),
// note-tags, and plugins.js parameter stems (joined in scan()).
function addRef(refCounts, ref) {
  const lower = ref.toLowerCase();
  if (!refCounts.has(lower)) refCounts.set(lower, new Map());
  const m = refCounts.get(lower);
  m.set(ref, (m.get(ref) || 0) + 1);
}

function collectRefs(payloadRoot) {
  const refCounts = new Map();
  let scanErrors = 0;
  const add = (ref) => addRef(refCounts, ref);
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

  // Collector 3: bare asset stems. Two sources feed one map:
  //  (a) plugin PARAMETER values in plugins.js (MOG 'Default FileName'-style
  //      options the editor bakes in, e.g. "Pic_1"), and
  //  (b) string literals in plugin/core JS source (hardcoded calls like
  //      ImageManager.reserveSystem(`gauge_effectMask`)).
  // Both name assets with no img/ prefix (invisible to LITERAL_RE) and no
  // data key. scan() joins them against the disk index; casing-differing
  // hits materialize case-variant copies — they never drive renames.
  const paramStems = new Map(); // value → count
  const addStem = (v) => {
    const s = v.trim();
    if (s.length >= 3 && s.length <= 120) {
      paramStems.set(s, (paramStems.get(s) || 0) + 1);
    }
  };
  const pluginsJs = path.join(payloadRoot, 'js', 'plugins.js');
  if (fs.existsSync(pluginsJs)) {
    try {
      const txt = fs.readFileSync(pluginsJs, 'utf8').replace(/^\uFEFF/, '');
      for (const value of collectParamStringValues(txt)) addStem(value);
    } catch { /* unreadable plugins.js — literal scan still covers paths */ }
  }
  for (const f of walkFiles(path.join(payloadRoot, 'js'), n => n.endsWith('.js'))) {
    try {
      for (const s of collectJsStringLiterals(fs.readFileSync(f, 'utf8'))) addStem(s);
    } catch { /* unreadable file */ }
  }

  // Collector 4: CSS url() references. gamefont.css declares the game font
  // with a RELATIVE url ("CALIFR.ttf") — and MV waits for GameFont at boot;
  // a casing drift there (disk CALIFR.TTF) hangs the game forever with no
  // error. Resolve urls relative to each stylesheet's directory.
  for (const f of walkFiles(payloadRoot, n => n.endsWith('.css'))) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''); } catch { continue; }
    const baseDir = path.relative(payloadRoot, path.dirname(f)).replace(/\\/g, '/');
    for (const m of txt.matchAll(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi)) {
      let u = m[1].trim();
      if (!u || /^(data:|https?:|\/)/i.test(u)) continue;
      u = u.replace(/^\.\//, '');
      const rel = baseDir === '' ? u : baseDir === '.' ? u : `${baseDir}/${u}`;
      // normalize ../ — keep it simple and safe
      const parts = [];
      for (const seg of rel.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.') parts.push(seg);
      }
      add(parts.join('/'));
    }
  }
  return { refCounts, paramStems, scanErrors };
}

// Extract every string literal ('…', "…", `…`) from JS source with a
// character-level walk. Comments are skipped crudely (quotes inside them may
// add phantom strings — harmless: they only matter when they case-insensitively
// equal an existing asset stem). Never evaluates the source.
function collectJsStringLiterals(txt) {
  const out = [];
  let i = 0, start = -1, quote = '';
  while (i < txt.length) {
    const c = txt[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) { out.push(txt.slice(start, i)); quote = ''; }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; start = i + 1; i++; continue; }
    if (c === '/' && txt[i + 1] === '/') { while (i < txt.length && txt[i] !== '\n') i++; continue; }
    if (c === '/' && txt[i + 1] === '*') { i = txt.indexOf('*/', i + 2); if (i === -1) break; i += 2; continue; }
    i++;
  }
  if (quote && start < txt.length) out.push(txt.slice(start));   // unterminated tail
  return out;
}

// Extract every string value inside `parameters: { … }` objects of a
// plugins.js text. The editor writes a JS object literal (unquoted keys,
// hand-editable comments) — NOT JSON — so instead of transforming text or
// evaluating untrusted content, walk the characters: find `parameters`
// (bare or quoted key), then collect string literals inside its balanced
// braces. Good enough for filename parameters by construction.
function collectParamStringValues(txt) {
  const out = [];
  const keyRe = /(?:"parameters"|'parameters'|parameters)\s*:\s*\{/g;
  let m;
  while ((m = keyRe.exec(txt))) {
    let depth = 1, i = m.index + m[0].length;
    while (i < txt.length && depth > 0) {
      const c = txt[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '"' || c === "'") {
        const quote = c;
        let val = '';
        i++;
        while (i < txt.length && txt[i] !== quote) {
          if (txt[i] === '\\' && i + 1 < txt.length) { val += txt[i + 1]; i += 2; }
          else { val += txt[i]; i++; }
        }
        out.push(val);
      }
      i++;
    }
  }
  return out;
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
  const { refCounts, paramStems, scanErrors } = collectRefs(payloadRoot);

  // Parameter-stem matching: index every asset file base (img/audio/effects/
  // movies only — matching "hero" against data/hero.json would be noise) by
  // lowercased dir+stem. A parameter stem whose lower form hits an entry with
  // DIFFERENT casing is a real reference the game will mispronounce on Linux;
  // register it once per extension that actually exists on disk, so plain
  // files flow through the exact-match branch and encrypted siblings
  // (.rpgmvp/.png_/…) through the enc-sibling branch below.
  // Parameter-only refs (marked below) never drive a RENAME: a bare parameter
  // string can coincide with an unrelated asset ("save" vs audio/se/Save.rpgmvo),
  // so they may only MATERIALIZE case variants in the plan branches.
  const paramRefs = new Set();
  if (paramStems && paramStems.size) {
    const ASSET_ROOTS = /^((img|audio|effects|movies|fonts)\/)/;
    const stemIndex = new Map(); // lower(stem) → [{ dir, diskStemOrig, exts[] }]
    for (const [lower, rels] of files) {
      if (!ASSET_ROOTS.test(lower)) continue;
      const slash = lower.lastIndexOf('/');
      const name = lower.slice(slash + 1);
      const dot = name.lastIndexOf('.');
      if (dot <= 0) continue;
      const dir = slash === -1 ? '' : lower.slice(0, slash);
      const origSlash = rels[0].lastIndexOf('/');
      const origName = rels[0].slice(origSlash + 1);
      const stemLower = name.slice(0, dot);
      let list = stemIndex.get(stemLower);
      if (!list) stemIndex.set(stemLower, list = []);
      const diskStemOrig = origName.slice(0, origName.lastIndexOf('.'));
      const e = list.find(x => x.dir === dir && x.diskStemOrig === diskStemOrig);
      if (e) e.exts.push(name.slice(dot));
      else list.push({ dir, diskStemOrig, exts: [name.slice(dot)] });
    }
    for (const [s, n] of paramStems) {
      const written = s.replace(/\\/g, '/');
      const slash = written.lastIndexOf('/');
      const stemPart = slash === -1 ? written : written.slice(slash + 1);
      const dirLower = slash === -1 ? null : written.slice(0, slash).toLowerCase();
      // bare stems match every asset dir holding that stem; 'dir/name'
      // parameters only match their directory
      const candidates = (stemIndex.get(stemPart.toLowerCase()) || [])
        .filter(e => dirLower === null || e.dir === dirLower);
      for (const e of candidates) {
        if (e.diskStemOrig === stemPart) continue;   // casing already exact
        for (const ext of e.exts) {
          for (let i = 0; i < n; i++) {
            const ref = `${e.dir}/${stemPart}${ext}`;
            addRef(refCounts, ref);
            paramRefs.add(ref.toLowerCase());        // low-confidence: never drives a rename (below)
          }
        }
      }
    }
  }

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
    // Organic (data/literal) casings drive the canonical casing; parameter-only
    // casings just materialize alongside it.
    const organic = [...casingMap.entries()].filter(([c]) => !paramRefs.has(c.toLowerCase()));
    const paramOnly = [...casingMap.keys()].filter(c => paramRefs.has(c.toLowerCase()) && !organic.some(([o]) => o === c));
    let canonical;
    if (organic.length) {
      const ranked = organic.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const topCount = ranked[0][1];
      const tied = ranked.filter(e => e[1] === topCount).length > 1;
      canonical = tied ? actual : ranked[0][0];
    } else {
      canonical = actual;                                  // parameters alone never rename
    }
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
    // stems as referenced (extension stripped), most-referenced wins; ties →
    // keep disk casing. Parameter-only stems never rename (materialize only).
    const hasOrganicCasing = (stem) => {
      for (const [w] of agg) if (!paramRefs.has(w.toLowerCase()) && w.slice(0, w.lastIndexOf('.')) === stem) return true;
      return false;
    };
    const organicStems = new Map();
    const paramStemsHere = new Map();
    for (const [w, n] of agg) {
      const stem = w.slice(0, w.lastIndexOf('.'));
      const into = !paramRefs.has(w.toLowerCase()) || hasOrganicCasing(stem) ? organicStems : paramStemsHere;
      into.set(stem, (into.get(stem) || 0) + n);
    }
    const ranked = [...(organicStems.size ? organicStems : paramStemsHere).entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const tied = ranked.length > 1 && ranked[0][1] === ranked[1][1];
    const diskStem = encDisk[0].slice(0, encDisk[0].length - enc.length);
    // parameters alone → canonical stays the disk casing
    const canonical = (!organicStems.size || tied ? diskStem : ranked[0][0]) + enc;
    if (canonical !== encDisk[0]) allFixes.push({ actual: encDisk[0], ref: canonical });
    for (const s of new Set([...organicStems.keys(), ...paramStemsHere.keys()])) if (s + enc !== canonical) duplicates.push({ target: canonical, as: s + enc });
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
