'use strict';
// Wrapper around the vendored EnigmaVB unpacker (unmodified upstream modules).
// RPGPort only needs the embedded file TREE — the rebuilt Windows stub exe is
// never written (equivalent of upstream's --no-exe).
const fs = require('fs');
const path = require('path');
const { readPE } = require('../pe');                 // our lightweight parser for detection
const upstream = require('./enigma-vb.js');          // { parseEnigmaHeader, detectVersion, Unpacker, Stream }
const upstreamPE = require('./pe-utils.js');         // { parsePE(path) → { data, findSection } }

const MAX_PACKED_BYTES = 2n * 1024n * 1024n * 1024n; // unpacker loads whole PE into RAM

function isPacked(peBuf) {
  const pe = readPE(peBuf);
  if (pe === null) return null;
  return pe.sections.some(s => /^\.?enigma1$/i.test(s.name));
}

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`unsafe path in archive: ${rel}`);
  return p;
}

async function unpack(packedExe, outDir, onProgress) {
  const size = fs.statSync(packedExe).size;
  if (BigInt(size) > MAX_PACKED_BYTES) {
    throw new Error(`packed exe is ${size} bytes (> 2 GiB); the unpacker loads it fully into RAM — refused`);
  }
  const pe = upstreamPE.parsePE(packedExe);
  const e1 = pe.findSection('.enigma1');
  if (!e1) throw new Error('no .enigma1 section — not an EnigmaVB-packed exe');
  const hdr = upstream.parseEnigmaHeader(pe, e1);
  const [label, code] = upstream.detectVersion(pe, e1, hdr);
  const stream = new upstream.Stream(pe.data);
  const up = new upstream.Unpacker(stream, code, e1.rawOffset + hdr.evbPtr, hdr.compressedFlag);
  up.walk();
  fs.mkdirSync(outDir, { recursive: true });
  let done = 0;
  for (const file of up.files) {
    const dest = safeJoin(outDir, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    up.extractFile(file, dest);
    if (onProgress && ++done % 100 === 0) onProgress(done, up.files.length);
  }
  return { enigmaVersion: label, fileCount: up.files.length, outDir };
}

module.exports = { isPacked, unpack };
