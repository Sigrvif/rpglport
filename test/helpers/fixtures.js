'use strict';
const fs = require('fs');
const path = require('path');
// Local test games, if any: set RPGLPORT_TEST_GAMES to a directory holding
// MV/ and/or MZ/ subfolders of RPG Maker MV/MZ games (each with any root exe).
// Every game found is used as a live fixture; nothing is hardcoded, and no
// game data ever enters the repository — tests skip the live parts when the
// variable is unset or a game is absent.
const BASE = process.env.RPGLPORT_TEST_GAMES || '';

function fixtureDirs() {
  if (!BASE) return [];
  const out = [];
  for (const engine of ['MV', 'MZ']) {
    const dir = path.join(BASE, engine);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const d = path.join(dir, name);
      // any root exe counts: deployments may name it after the game, not Game.exe
      try {
        const hasExe = fs.readdirSync(d).some(n => /\.exe$/i.test(n));
        if (hasExe) out.push(d);
      } catch { /* not a directory */ }
    }
  }
  return out;
}

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

module.exports = { fixtureDirs, synthPE, utf16 };
