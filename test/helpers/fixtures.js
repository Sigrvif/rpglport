'use strict';
const fs = require('fs');
const path = require('path');
const BASE = '<test-games-pool>';
const FIXTURES = [
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
  const PE_OFF = 0x80, SEC_OFF = PE_OFF + 24, DATA = SEC_OFF + sections.length * 40;
  const buf = Buffer.alloc(DATA + blob.length + 16);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(PE_OFF, 0x3c);
  buf.writeUInt32LE(0x00004550, PE_OFF);   // PE\0\0
  buf.writeUInt16LE(machine, PE_OFF + 4);
  buf.writeUInt16LE(sections.length, PE_OFF + 6);
  buf.writeUInt16LE(0, PE_OFF + 20);       // SizeOfOptionalHeader = 0
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
