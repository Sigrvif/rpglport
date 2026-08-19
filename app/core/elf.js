'use strict';
// ELF inspection: executable-stack fix for old NW.js libnode.so, runtime
// version stamps (node.js/vX + Chrome/N), and machine arch. ELF32+ELF64 LE.
const fs = require('fs');
const path = require('path');
const PT_GNU_STACK = 0x6474e551, PF_X = 1;

function parseHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 52 || buf.toString('ascii', 0, 4) !== '\x7fELF') return null;
  if (buf[5] !== 1) return null; // little-endian only
  const is64 = buf[4] === 2;
  const machine = buf.readUInt16LE(18);
  const arch = machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : null;
  const phoff = is64 ? Number(buf.readBigUInt64LE(32)) : buf.readUInt32LE(28);
  const phentsize = buf.readUInt16LE(is64 ? 54 : 42);
  const phnum = buf.readUInt16LE(is64 ? 56 : 44);
  return { is64, arch, phoff, phentsize, phnum };
}

function elfArch(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    fs.closeSync(fd);
    const h = parseHeader(head.subarray(0, 64));
    return h ? h.arch : null;
  } catch { return null; }
}

// Clear PT_GNU_STACK PF_X (old NW.js libnode.so ships RWX stack; hardened
// kernels refuse to load it). Returns true if the file was modified.
function clearExecStack(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return false; }
  const h = parseHeader(buf);
  if (!h) return false;
  let changed = false;
  for (let i = 0; i < h.phnum; i++) {
    const o = h.phoff + i * h.phentsize;
    if (o + 8 > buf.length) break;
    if (buf.readUInt32LE(o) === PT_GNU_STACK) {
      const flags = buf.readUInt32LE(o + 4);
      if (flags & PF_X) {
        buf.writeUInt32LE(flags & ~PF_X, o + 4);
        changed = true;
      }
    }
  }
  if (changed) {
    const mode = fs.statSync(file).mode;
    fs.writeFileSync(file, buf, { mode });
    fs.chmodSync(file, mode); // writeFileSync may drop exec bits
  }
  return changed;
}

// Version-ish string stamps from a (possibly large) ELF binary.
function stringStamps(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { nodes: [], chromes: [] }; }
  const s = buf.toString('latin1');
  const nodes = [], chromes = [];
  for (const m of s.matchAll(/node\.js\/v(\d+\.\d+\.\d+)/g)) if (!nodes.includes(m[1])) nodes.push(m[1]);
  for (const m of s.matchAll(/Chrome\/(\d+)\./g)) if (!chromes.includes(m[1])) chromes.push(m[1]);
  return { nodes, chromes };
}

// Pool admission data for a runtime directory: stamps from nw, lib/libnw.so,
// and lib/libnode.so (node stamps live in lib/libnode.so; newer runtimes may
// carry none at all — dir-name versioning is the fallback in select.js).
function runtimeStamps(dir) {
  const candidates = [path.join(dir, 'nw'), path.join(dir, 'lib', 'libnw.so'), path.join(dir, 'lib', 'libnode.so')];
  let ok = false, arch = null, nodes = [], chromes = [];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    ok = true;
    const a = elfArch(c);
    if (a) arch = arch || a;
    const st = stringStamps(c);
    nodes = [...new Set([...nodes, ...st.nodes])];
    chromes = [...new Set([...chromes, ...st.chromes])];
  }
  return { ok, arch, nodes, chromes };
}

module.exports = { clearExecStack, elfArch, stringStamps, runtimeStamps, parseHeader };
