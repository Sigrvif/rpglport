'use strict';
const fs = require('fs');
const path = require('path');
const BASE = '<test-games-pool>';
const FIXTURES = [
  `${BASE}/MV/game-mv-1`,
  `${BASE}/MV/game-mv-2`,
  `${BASE}/MV/game-mv-3`,
  `${BASE}/MV/game-mv-4`,
  `${BASE}/MV/game-mv-5`,
  `${BASE}/MZ/game-mz-1`,
  `${BASE}/MZ/game-mz-2`,
];
function fixtureDirs() { return FIXTURES.filter(d => fs.existsSync(path.join(d, 'Game.exe'))); }

function utf16(s) {
  const b = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2);
  return b;
}

// Minimal synthetic PE: MZ header, PE signature, machine, section table, optional UTF-16 blob.
function synthPE({ machine = 0x8664, sections = [], utf16: blob = Buffer.alloc(0) } = {}) {
  // Minimal PE32+ with a real optional header (240 bytes, magic 0x20b) —
  // required by parsers that read the optional header eagerly.
  const PE_OFF = 0x80, OPT_SIZE = 240, SEC_OFF = PE_OFF + 24 + OPT_SIZE, DATA = SEC_OFF + sections.length * 40;
  const buf = Buffer.alloc(DATA + blob.length + 16);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(PE_OFF, 0x3c);
  buf.writeUInt32LE(0x00004550, PE_OFF);   // PE\0\0
  buf.writeUInt16LE(machine, PE_OFF + 4);
  buf.writeUInt16LE(sections.length, PE_OFF + 6);
  buf.writeUInt16LE(OPT_SIZE, PE_OFF + 20);
  buf.writeUInt16LE(0x020b, PE_OFF + 24);  // PE32+ optional-header magic
  sections.forEach((s, i) => {
    const o = SEC_OFF + i * 40;
    buf.write(s.name, o, 'ascii');
    buf.writeUInt32LE(0x100, o + 16);      // raw size
    buf.writeUInt32LE(DATA, o + 20);       // raw offset
  });
  blob.copy(buf, DATA);
  return buf;
}

module.exports = { fixtureDirs, synthPE, utf16, FIXTURES };
