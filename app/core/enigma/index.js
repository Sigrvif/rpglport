'use strict';
// Wrapper around the vendored EnigmaVB unpacker (unmodified upstream modules,
// v1.1.0: file-backed parsing — headers parsed eagerly, payload read on demand
// via the PE's fd, so memory stays flat regardless of exe size).
// RPGLPort only needs the embedded file TREE — the rebuilt Windows stub exe is
// never written (equivalent of upstream's --no-exe).
const fs = require('fs');
const path = require('path');
const { readPE } = require('../pe');                 // our lightweight parser for detection
const upstream = require('./enigma-vb.js');          // { parseEnigmaHeader, detectVersion, Unpacker, Stream }
const upstreamPE = require('./pe-utils.js');         // { PE, parsePE (file-backed, needs close()) }

// PE section offsets are 32-bit — the format cannot place .enigma1 data
// reliably beyond the 4 GiB mark, and nothing that big has ever been seen in
// the wild. Refused conservatively with a clear message.
const PE_FORMAT_LIMIT = 4n * 1024n * 1024n * 1024n;

const fmtGiB = (bytes) => `${(Number(bytes) / 1024 ** 3).toFixed(1)} GiB`;

function admitSize(size) {
  if (BigInt(size) > PE_FORMAT_LIMIT) {
    return { ok: false, reason: `packed exe is ${fmtGiB(size)} — beyond the 4 GiB PE offset limit; EnigmaVB data there would be unaddressable` };
  }
  return { ok: true, reason: '' };
}

function isPacked(peBuf) {
  const pe = readPE(peBuf);
  if (pe === null) return null;
  return pe.sections.some(s => /^\.?enigma1$/i.test(s.name));
}

// fail-closed: an unsafe member path aborts the whole unpack (partial tree left
// behind) — security over convenience; upstream skips instead.
function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`unsafe path in archive: ${rel}`);
  return p;
}

// Vendored paths use Windows separators; the tree must be rebuilt POSIX-style.
function toPosix(rel) { return String(rel).replace(/\\/g, '/'); }

async function unpack(packedExe, outDir, onProgress) {
  const size = fs.statSync(packedExe).size;
  const admitted = admitSize(size);
  if (!admitted.ok) throw new Error(admitted.reason);
  const pe = upstreamPE.parsePE(packedExe);          // file-backed: flat memory, no 2 GiB cap
  try {
    const e1 = (pe.sections || []).find(s => /^\.?enigma1$/i.test(s.name));
    if (!e1) throw new Error('no .enigma1 section — not an EnigmaVB-packed exe');
    const hdr = upstream.parseEnigmaHeader(pe, e1);
    const [label, code] = upstream.detectVersion(pe, e1, hdr);
    const stream = new upstream.Stream(pe);          // file-backed stream (read-ahead cache)
    const up = new upstream.Unpacker(stream, code, e1.rawOffset + hdr.evbPtr, hdr.compressedFlag);
    up.walk();
    fs.mkdirSync(outDir, { recursive: true });
    let done = 0;
    for (const file of up.files) {
      const dest = safeJoin(outDir, toPosix(file.path));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      up.extractFile(file, dest);
      if (onProgress && ++done % 100 === 0) onProgress(done, up.files.length);
    }
    return { enigmaVersion: label, fileCount: up.files.length, outDir };
  } finally {
    pe.close();                                      // release the fd on every path
  }
}

module.exports = { isPacked, unpack, toPosix, safeJoin, admitSize };