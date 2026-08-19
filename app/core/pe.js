'use strict';
// PE inspection: architecture, section names, NW.js version stamps.
// Pure Buffer logic — no external deps. Used by detect.js and enigma detection.

function readPE(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x40) return null;
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return null;            // MZ
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff <= 0 || peOff + 24 > buf.length) return null;
  if (buf.readUInt32LE(peOff) !== 0x00004550) return null;        // PE\0\0
  const machine = buf.readUInt16LE(peOff + 4);
  const arch = machine === 0x8664 ? 'x64' : machine === 0x014c ? 'x86' : null;
  const numSections = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const secOff = peOff + 24 + optSize;
  const sections = [];
  for (let i = 0; i < numSections && secOff + i * 40 + 40 <= buf.length; i++) {
    const o = secOff + i * 40;
    let name = '';
    for (let j = 0; j < 8; j++) { const c = buf[o + j]; if (!c) break; name += String.fromCharCode(c); }
    sections.push({ name, rawSize: buf.readUInt32LE(o + 16), rawOffset: buf.readUInt32LE(o + 20) });
  }
  // NW.js version stamps from UTF-16LE version-resource strings:
  // a "ProductVersion"/"FileVersion" key immediately followed by an 0.x.y value.
  const stamps = [];
  const runs = utf16Runs(buf, 4);
  for (let i = 0; i + 1 < runs.length; i++) {
    if (runs[i] === 'ProductVersion' || runs[i] === 'FileVersion') {
      const v = runs[i + 1].replace(/\s+/g, '');
      if (/^0\.\d+\.\d+(-[\w.]+)?$/.test(v) && !stamps.includes(v)) stamps.push(v);
    }
  }
  return { arch, sections, stamps };
}

// UTF-16LE ASCII runs, for resource-value extraction.
function utf16Runs(buf, minChars) {
  const out = [];
  let cur = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const lo = buf[i], hi = buf[i + 1];
    if (hi === 0 && lo >= 0x20 && lo <= 0x7e) { cur += String.fromCharCode(lo); }
    else { if (cur.length >= minChars) out.push(cur); cur = ''; }
  }
  if (cur.length >= minChars) out.push(cur);
  return out;
}

function nodeStamps(buf) {
  const out = [];
  for (const m of buf.toString('latin1').matchAll(/node\.js\/v(\d+\.\d+\.\d+)/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function chromeStamps(buf) {
  const majors = [], fulls = [];
  const s = buf.toString('latin1');
  for (const m of s.matchAll(/Chrome\/(\d+)\./g)) if (!majors.includes(m[1])) majors.push(m[1]);
  for (const m of s.matchAll(/(\d{2,3}\.\d+\.\d+\.\d+)/g)) if (!fulls.includes(m[1])) fulls.push(m[1]);
  return { majors, fulls };
}

function isEnigmaPacked(pe) {
  return !!pe && pe.sections.some(s => /^\.?enigma1$/i.test(s.name));
}

module.exports = { readPE, nodeStamps, chromeStamps, isEnigmaPacked, utf16Runs };
