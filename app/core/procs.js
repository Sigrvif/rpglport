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

module.exports = { descendantCmdline };
