'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clearExecStack, elfArch, stringStamps, runtimeStamps } = require('../app/core/elf');

function synthElf64(machine, stackFlags) {
  const phoff = 0x40, phentsize = 0x38, phnum = 1;
  const buf = Buffer.alloc(phoff + phentsize);
  buf.write('\x7fELF', 0, 'ascii');
  buf[4] = 2; buf[5] = 1;              // 64-bit LE
  buf.writeUInt16LE(0x03, 16);         // ET_DYN
  buf.writeUInt16LE(machine, 18);
  buf.writeBigUInt64LE(BigInt(phoff), 32);
  buf.writeUInt16LE(phentsize, 54);
  buf.writeUInt16LE(phnum, 56);
  buf.writeUInt32LE(0x6474e551, phoff);        // PT_GNU_STACK
  buf.writeUInt32LE(stackFlags, phoff + 4);
  return buf;
}

test('clearExecStack clears PF_X on PT_GNU_STACK, idempotent', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elf-')), 'lib.so');
  fs.writeFileSync(f, synthElf64(0x3e, 0x7));            // RWX
  assert.equal(clearExecStack(f), true);
  const re = fs.readFileSync(f);
  assert.equal(re.readUInt32LE(0x40 + 4) & 1, 0);        // X bit gone, rest kept
  assert.equal(clearExecStack(f), false);                // second run: no change
});

test('elfArch + runtimeStamps on real runtimes', { skip: !fs.existsSync('runtimes/nwjs-v0.29.0-linux-x64/nw') }, () => {
  // Ground truth: the 0.29/0.48-era Linux runtimes in our cache contain NO
  // `Chrome/` strings anywhere (verified); modern hosts (≥0.11x) DO carry
  // `Chrome/<major>.` in libnw.so — which select.js's chrome-major fallback
  // relies on for host admission. The node stamp lives in lib/libnode.so
  // (not in `nw`); 0.48.4 carries NO node stamp at all — its admission
  // relies on the directory name.
  assert.equal(elfArch('runtimes/nwjs-v0.29.0-linux-x64/nw'), 'x64');
  assert.equal(elfArch('runtimes/nwjs-v0.29.0-linux-x64/lib/libnode.so'), 'x64');
  const st = stringStamps('runtimes/nwjs-v0.29.0-linux-x64/lib/libnode.so');
  assert.ok(st.nodes.includes('9.7.1'));
  const rt = runtimeStamps('runtimes/nwjs-v0.29.0-linux-x64');
  assert.equal(rt.arch, 'x64');
  assert.ok(rt.nodes.includes('9.7.1'));                 // found via lib/libnode.so
  if (fs.existsSync('runtimes/nwjs-v0.48.4-linux-x64/nw')) {
    const rt2 = runtimeStamps('runtimes/nwjs-v0.48.4-linux-x64');
    assert.equal(rt2.ok, true);
    assert.equal(rt2.arch, 'x64');
    assert.deepEqual(rt2.nodes, []);                     // dir-name fallback drives admission
  }
});

test('runtimeStamps on missing dir returns not-ok', () => {
  assert.equal(runtimeStamps('/nonexistent/rpgport-xyz').ok, false);
});
