'use strict';
// /proc-based process inspection for Test Run verdicts (Linux-only tool).
const fs = require('fs');

// True when some descendant of rootPid has `needle` in its cmdline. NW.js
// spawns a `--type=renderer` child the moment the app window starts loading;
// its absence after a full verdict window means the process is idling with no
// window at all (old-runtime class). One /proc snapshot per call; on any
// error we assume yes so verdicts stay conservative.
function descendantCmdline(rootPid, needle) {
  let procs;
  try {
    procs = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(n => {
      const pid = Number(n);
      let ppid = null, cmd = '';
      try {
        // comm may contain spaces/parens — fields resume after the last ')'
        const stat = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).trim().split(/\s+/);
        ppid = Number(fields[1]);
        cmd = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').replace(/\0+/g, ' ');
      } catch { /* raced exit — keep what we have */ }
      return { pid, ppid, cmd };
    });
  } catch { return true; }
  const byPid = new Map(procs.map(p => [p.pid, p]));
  for (const p of procs) {
    if (!p.cmd.includes(needle)) continue;
    let cur = p, guard = 0;
    while (cur && guard++ < 4096) {
      if (cur.pid === rootPid) return true;
      cur = byPid.get(cur.ppid);
    }
  }
  return false;
}

// Parse the Test-Run diagnostic marker. Summary keys frames/med/max/span sit
// space-separated on ONE line (only scene=/renderer=/error= start lines), so
// summary keys must match at word boundaries — anchoring them at line starts
// read them as 0 and made healthy runs look frozen.
function parseDiag(text) {
  const lines = text.split('\n');
  let summary = null;
  for (const l of lines) if (/\bframes=\d+/.test(l)) summary = l;
  const num = (k) => {
    const m = summary && summary.match(new RegExp('\\b' + k + '=(\\d+)'));
    return m ? parseInt(m[1], 10) || 0 : 0;
  };
  const g = (re) => { const m = text.match(re); return m ? m[1] : null; };
  return {
    scene: g(/^scene=(.*)$/m) || 'none',
    renderer: g(/^renderer=(.*)$/m) || 'unknown',
    frames: num('frames'),
    med: num('med'),
    max: num('max'),
    span: num('span'),
    error: g(/^error=(.*)$/m),
    stalls: lines.filter(l => /^stall /.test(l)).slice(-20),
  };
}

module.exports = { descendantCmdline, parseDiag };
