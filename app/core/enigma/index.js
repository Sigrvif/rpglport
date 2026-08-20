'use strict';
// Wrapper around the vendored EnigmaVB unpacker (unmodified upstream modules).
// RPGPort only needs the embedded file TREE — the rebuilt Windows stub exe is
// never written (equivalent of upstream's --no-exe).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPE } = require('../pe');                 // our lightweight parser for detection
const upstream = require('./enigma-vb.js');          // { parseEnigmaHeader, detectVersion, Unpacker, Stream }
const upstreamPE = require('./pe-utils.js');         // { PE, parsePE }

// PE section offsets are 32-bit — the parser cannot address anything past
// 4 GiB into a file, so bigger packed exes are refused on format grounds.
const PE_FORMAT_LIMIT = 4n * 1024n * 1024n * 1024n;

const fmtGiB = (bytes) => `${(Number(bytes) / 1024 ** 3).toFixed(1)} GiB`;

// The unpacker memory-loads the whole packed PE. The only real constraints on
// 64-bit Node are free RAM and the 4 GiB PE offset limit — NOT the historic
// "2 GiB" figure (that was 32-bit address space folklore upstream, plus the
// fact that fs.readFileSync itself caps at 2 GiB, which readFileBig bypasses).
function admitSize(size, freeBytes) {
  if (BigInt(size) > PE_FORMAT_LIMIT) {
    return { ok: false, reason: `packed exe is ${fmtGiB(size)} — beyond the 4 GiB PE offset limit; EnigmaVB data there would be unaddressable` };
  }
  if (size > Math.floor(freeBytes * 0.75)) {
    return { ok: false, reason: `packed exe is ${fmtGiB(size)} but only ${fmtGiB(freeBytes)} of RAM is free — close other applications and retry` };
  }
  return { ok: true, reason: '' };
}

// fs.readFileSync throws ERR_FS_FILE_TOO_LARGE for anything over 2 GiB, and
// fs.readSync's length/offset params are int32-bounded — so read through a
// bounded chunk buffer into a pre-allocated Buffer (legal up to
// buffer.constants.MAX_LENGTH, far beyond anything EnigmaVB can produce).
function readFileBig(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(size);
    const chunk = Buffer.allocUnsafe(Math.min(16 * 1024 * 1024, Math.max(size, 1)));
    let read = 0;
    while (read < size) {
      const want = Math.min(chunk.length, size - read);
      const n = fs.readSync(fd, chunk, 0, want, read); // position accepts > 2^31
      if (n <= 0) throw new Error('short read');
      chunk.copy(buf, read, 0, n);
      read += n;
    }
    return buf;
  } finally {
    fs.closeSync(fd);
  }
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
  const admitted = admitSize(size, os.freemem());
  if (!admitted.ok) throw new Error(admitted.reason);
  let data;
  try {
    data = readFileBig(packedExe);
  } catch (e) {
    throw new Error(`could not load packed exe into memory: ${e.message}`);
  }
  const pe = new upstreamPE.PE(data);
  const e1 = (pe.sections || []).find(s => /^\.?enigma1$/i.test(s.name));
  if (!e1) throw new Error('no .enigma1 section — not an EnigmaVB-packed exe');
  const hdr = upstream.parseEnigmaHeader(pe, e1);
  const [label, code] = upstream.detectVersion(pe, e1, hdr);
  const stream = new upstream.Stream(pe.data);
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
}

module.exports = { isPacked, unpack, toPosix, safeJoin, admitSize, readFileBig };
