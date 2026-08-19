"use strict";

/** Minimal PE parser for locating .enigma1/.enigma2 sections.
 *
 * Port of pe_utils.py. Only implements what the unpacker needs:
 *   - section table read
 *   - optional header field reads
 *   - PE rebuilder (strip last two sections)
 */

const PE_SIG = Buffer.from([0x50, 0x45, 0x00, 0x00]); // "PE\0\0"

class Section {
  constructor(opts) {
    Object.assign(this, opts);
  }
}

class PE {
  constructor(data) {
    this.data = data; // Buffer
    this.peOffset = data.readUInt32LE(0x3c);
    if (data.subarray(this.peOffset, this.peOffset + 4).compare(PE_SIG) !== 0) {
      throw new Error("not a PE file");
    }
    this.numSections = data.readUInt16LE(this.peOffset + 6);
    this.optSize = data.readUInt16LE(this.peOffset + 20);
    this.optStart = this.peOffset + 24;
    this.optMagic = data.readUInt16LE(this.optStart);
    this.isPE32Plus = this.optMagic === 0x20b;
    this.sectionTable = this.optStart + this.optSize;
    this.sections = [];
    for (let i = 0; i < this.numSections; i++) {
      const base = this.sectionTable + i * 40;
      const nameBytes = data.subarray(base, base + 8);
      const nameEnd = nameBytes.indexOf(0);
      this.sections.push(new Section({
        name: (nameEnd >= 0 ? nameBytes.subarray(0, nameEnd) : nameBytes).toString("latin1"),
        virtualSize: data.readUInt32LE(base + 8),
        virtualAddress: data.readUInt32LE(base + 12),
        rawSize: data.readUInt32LE(base + 16),
        rawOffset: data.readUInt32LE(base + 20),
        characteristics: data.readUInt32LE(base + 36),
      }));
    }
  }

  findSection(name) {
    return this.sections.find(s => s.name === name) || null;
  }
}

function parsePE(filePath) {
  const fs = require("fs");
  return new PE(fs.readFileSync(filePath));
}

/** Rebuild _unpacked.exe: remove .enigma1/.enigma2, patch header. */
function rebuildPE(pe, e1, e2, outPath) {
  const fs = require("fs");
  const data = Buffer.from(pe.data); // copy
  const peOff = pe.peOffset;
  const coffOff = peOff + 4;
  const optOff = pe.optStart;
  const newNum = pe.numSections - 2;
  data.writeUInt16LE(newNum, coffOff + 2);

  // Truncate to end of new last section
  const lastKept = pe.sections[pe.sections.length - 3] || pe.sections[0];
  const endOfData = lastKept.rawOffset + lastKept.rawSize;

  // Patch SizeOfImage
  let newSizeOfImage = lastKept.virtualAddress + lastKept.virtualSize;
  const sectionAlign = pe.data.readUInt32LE(optOff + 32);
  if (sectionAlign > 0) {
    newSizeOfImage = (newSizeOfImage + sectionAlign - 1) & ~(sectionAlign - 1);
  }
  data.writeUInt32LE(newSizeOfImage >>> 0, optOff + 56);

  // Zero out removed section entries
  for (let i = newNum; i < pe.numSections; i++) {
    data.fill(0, pe.sectionTable + i * 40, pe.sectionTable + (i + 1) * 40);
  }

  fs.writeFileSync(outPath, data.subarray(0, endOfData));
}

module.exports = { PE, Section, parsePE, rebuildPE };
