'use strict';
/* RPGLPort GUI — thin layer over app/core (NW.js: Node available in page). */
const path = require('path');
const fs = require('fs');
const gui = require('nw.gui');
const Shell = gui.Shell;                    // NW exposes Shell (capital) — not lowercase like Electron
const { analyzeInput, portCard, PortQueue, selftest, findLiveDisplays, hasXvfbRun, findProcDisplayPairs, xauthorityCandidates, findSessionEnvs } = require('./core/engine');
const { listPool, choose, USABLE_FLOOR } = require('./core/select');
const { cmpVer } = require('./core/detect');
const settings = require('./core/settings');

const ROOT = findRoot();  // bundle root: the dir containing app/core/engine.js
function findRoot() {
  // Release layout: execPath=<bundle>/nw → dirname is the bundle.
  // Dev layout: run-dev.sh execs _host/nw with cwd=<repo> — so try cwd first,
  // then walk up from execPath. First dir containing app/core/engine.js wins.
  const candidates = [process.cwd(), path.dirname(process.execPath)];
  for (const start of candidates) {
    let d = start;
    for (let i = 0; i < 4; i++) {
      if (fs.existsSync(path.join(d, 'app', 'core', 'engine.js'))) return d;
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
  }
  return path.dirname(process.execPath); // last resort; selftest will complain
}
const SZ = path.join(ROOT, 'bin', '7zz');
// Version shown in the header: build.json (release) → package.json (dev) → ?
function readVersion() {
  for (const f of [path.join(ROOT, 'build.json'), path.join(ROOT, 'package.json')]) {
    try { const v = JSON.parse(fs.readFileSync(f, 'utf8')).version; if (v) return v; } catch { /* next */ }
  }
  return '0.0.0-unknown';
}
const TOOL_VERSION = readVersion();
const queue = new PortQueue();
const state = { pool: [], rejected: [], cards: new Map(), settings: settings.load() };

const $ = (s) => document.querySelector(s);

function toast(msg, cls = '') {
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function appendLog(id, line) {
  const card = state.cards.get(id);
  if (!card) return;
  card.logs.push(line);
  if (card.logEl.classList.contains('open')) card.logEl.textContent = card.logs.join('\n');
}

async function refreshPool() {
  ({ pool: state.pool, rejected: state.rejected } = listPool(ROOT));
  $('#poolIndicator').textContent = `RPGLPort v${TOOL_VERSION} · pool: ${state.pool.length} runtimes`;
  const list = $('#poolList');
  list.innerHTML = '';
  for (const p of state.pool) {
    const row = document.createElement('div');
    const left = document.createElement('span');
    left.textContent = p.version;
    const right = document.createElement('span');
    right.textContent = `${p.source}${p.chromiumMajor ? ` · C${p.chromiumMajor}` : ''}`;
    row.append(left, right);
    if (p.source === 'imported') {
      const rm = document.createElement('button');
      rm.className = 'mini'; rm.textContent = 'remove';
      rm.onclick = () => { fs.rmSync(p.path, { recursive: true, force: true }); refreshPool(); };
      row.appendChild(rm);
    }
    list.appendChild(row);
  }
  for (const r of state.rejected) {
    const row = document.createElement('div');
    const left = document.createElement('span');
    left.textContent = r.name;
    const right = document.createElement('span');
    right.textContent = r.reason;
    right.style.color = 'var(--err)';
    row.append(left, right);
    list.appendChild(row);
  }
  for (const card of state.cards.values()) if (card.selEl) fillRuntimeSelect(card);
}

function runtimeLabel(p, card) {
  const r = choose(state.pool, card.info.detectedNW, card.info.engine, card.info.engineVersion, p.version);
  const tag = r.refused ? ' (refused: MZ floor)' : r.runtime ? `(+C${r.runtime.chromiumMajor})` : '';
  const legacy = cmpVer(p.version, USABLE_FLOOR) < 0 ? ' — legacy, never auto-picked (no window on modern Linux)' : '';
  return `${p.version} ${tag}${legacy}`.trim();
}

function fillRuntimeSelect(card) {
  const sel = card.selEl;
  sel.innerHTML = '';
  for (const p of state.pool) {
    const opt = document.createElement('option');
    opt.value = p.version; opt.textContent = runtimeLabel(p, card);
    if (card.chosen ? card.chosen.version === p.version : p.version === card.autoPick?.version) opt.selected = true;
    sel.appendChild(opt);
  }
}

function setStatus(card, text, cls = '') {
  card.statusEl.textContent = text;
  card.statusEl.className = `status ${cls}`;
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  const isErr = !!card.error;
  el.innerHTML = `
    <div class="top">
      <span class="name"></span>
      <span class="badgeSlot"></span>
      <span class="status">analyzing…</span>
    </div>
    <div class="ev"></div>
    <div class="rt"></div>
    <progress value="0" max="1" hidden></progress>
    <div class="actions">
      <button class="bPort" ${isErr ? 'hidden' : ''}>Port</button>
      <button class="bOpen" hidden>Open</button>
      <button class="bTest" hidden>Test run</button>
      <button class="bDiag" hidden>Diag play</button>
      <button class="bLog">Log</button>
      <button class="bRemove">Remove</button>
    </div>
    <div class="log"></div>`;
  el.querySelector('.name').textContent = card.name;                 // never innerHTML — paths may contain < &
  const badgeSlot = el.querySelector('.badgeSlot');
  if (isErr) { const b = document.createElement('span'); b.className = 'badge err'; b.textContent = 'error'; badgeSlot.appendChild(b); }
  else if (card.info) {
    const b = document.createElement('span');
    b.className = `badge ${card.info.engine === 'MZ' ? 'mz' : ''}`;
    b.textContent = `${card.info.engine} ${card.info.engineVersion || ''}`;
    badgeSlot.appendChild(b);
  }
  $('#queue').appendChild(el);
  Object.assign(card, {
    el, logs: [],
    statusEl: el.querySelector('.status'), evEl: el.querySelector('.ev'),
    logEl: el.querySelector('.log'), progEl: el.querySelector('progress'),
    selEl: null,
  });
  if (isErr) { setStatus(card, card.error, 'error'); return; }
  const ev = card.info.evidence.map(e => `${e.src}→${e.value}`).join(' · ');
  card.evEl.textContent = `${ev}${card.warnings?.length ? ' · ' + card.warnings.join(' · ') : ''}`;
  const r = choose(state.pool, card.info.detectedNW, card.info.engine, card.info.engineVersion);
  if (r.refused) { setStatus(card, r.refused, 'error'); card.evEl.textContent += ` — ${r.refused}`; }
  else {
    card.autoPick = r.runtime; card.autoNotes = r;
    card.selEl = document.createElement('select');
    fillRuntimeSelect(card);
    card.selEl.onchange = () => {
      card.chosen = state.pool.find(p => p.version === card.selEl.value);
    };
    el.querySelector('.rt').appendChild(card.selEl);
    const why = [...r.notes, ...r.warnings].join('; ') || 'no notes';
    card.evEl.title = why;
    appendLog(card.id, `detected ${card.info.detectedNW} → ${r.runtime.version}: ${why}`);
    setStatus(card, `ready (${r.runtime.version})`);
  }
  el.querySelector('.bLog').onclick = () => { card.logEl.classList.toggle('open'); card.logEl.textContent = card.logs.join('\n'); };
  el.querySelector('.bRemove').onclick = () => {
    if (card.jobToken) card.jobToken.cancelled = true;   // queued job dropped; in-flight stops at file boundary
    state.cards.delete(card.id); el.remove();
  };
  el.querySelector('.bPort').onclick = () => doPort(card);   // doPort does its own queue.enqueue — wrapping it in enqueue deadlocks
  el.querySelector('.bOpen').onclick = () => {
    if (!card.finalDir) return;
    appendLog(card.id, `revealing in file manager: ${card.finalDir}`);
    try { Shell.showItemInFolder(card.finalDir); }
    catch (e) {
      appendLog(card.id, `Shell reveal failed (${e.message}) — falling back to xdg-open`);
      try {
        spawn('xdg-open', [card.finalDir], { detached: true, stdio: 'ignore' }).unref();
      } catch (e2) { appendLog(card.id, `xdg-open failed too: ${e2.message} — the folder is at ${card.finalDir}`); }
    }
  };
  el.querySelector('.bTest').onclick = () => doTestRun(card);
  el.querySelector('.bDiag').onclick = () => doDiagRun(card);
}

async function addInputs(paths) {
  for (const p of paths) {
    const { cards } = await analyzeInput(p, { sevenZip: SZ });
    for (const c of cards) { state.cards.set(c.id, c); renderCard(c); }
  }
}

async function doPort(card) {
  if (card.porting) return;                              // re-entry guard: port/test in flight or prompt open
  card.porting = true;
  const runtime = card.chosen || card.autoPick;
  if (!runtime) { card.porting = false; return toast('no runtime available — check the pool', 'err'); }
  const s = state.settings;
  const dirName = `${card.name} (Linux)`;
  // Spec §8: output-exists prompt — refuse (default) / overwrite / new name.
  const outDir = path.join(s.outDir, dirName);
  if (fs.existsSync(outDir)) {
    const choice = await existsPrompt(outDir);
    if (choice === 'refuse') { card.porting = false; setStatus(card, 'ready (kept existing output)'); return; }
    card.onExists = choice;
  }
  card.progEl.hidden = false;
  setStatus(card, 'porting…');
  const job = queue.enqueue((token) => portCard(card, {
    runtime,
    outParent: s.outDir,
    dirName,
    onExists: card.onExists || 'refuse',
    onProgress: ({ files, bytes }) => { card.progEl.value = Math.min(1, bytes / 400e6); setStatus(card, `porting… ${files} files`); },
    cancel: token,
  }));
  card.jobToken = job.token;
  try {
    const r = await job.promise;
    card.finalDir = r.finalDir;
    card.progEl.hidden = true;
    const scan = card.scan || { counts: { fixes: 0, warnings: 0 } };
    const m = scan.counts.warnings + r.warnings.length;
    setStatus(card, `done — ${scan.counts.fixes} case fixes · ${m} warnings`, m ? 'warn' : 'done');
    card.el.querySelector('.bOpen').hidden = false;
    card.el.querySelector('.bTest').hidden = false;
    card.el.querySelector('.bDiag').hidden = false;
    appendLog(card.id, `ported → ${r.finalDir}`);
    for (const w of r.warnings) appendLog(card.id, `warning: ${w}`);
    // spec §4: cleaned unless the user keeps extracted copies (folders have no extractDir)
    if (!s.keepExtracted && card.extractDir) {
      try { fs.rmSync(card.extractDir, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    card.progEl.hidden = true;
    setStatus(card, `error: ${e.message}`, 'error');
    appendLog(card.id, `ERROR ${e.stack || e.message}`);
  } finally {
    card.porting = false;
  }
}

function existsPrompt(outDir) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<p>Output already exists:<br><code></code></p>
      <div class="row"><button data-a="refuse">Keep existing (cancel)</button>
      <button data-a="overwrite">Overwrite</button><button data-a="newname">New name</button></div>`;
    dlg.querySelector('code').textContent = outDir;
    let settled = false;
    const finish = (a) => { if (settled) return; settled = true; dlg.remove(); resolve(a); };
    dlg.onclick = (e) => { const a = e.target.dataset && e.target.dataset.a; if (a) finish(a); };
    dlg.oncancel = () => finish('refuse');                // Esc → same as "keep existing"
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

const { spawn } = require('child_process');
const procs = require('./core/procs');

// Test Run display ladder. A live X socket is NOT sufficient — the server can
// reject the client during setup for lack of the session cookie (GTK reports
// the same "cannot open display"). So we discover DISPLAY+XAUTHORITY pairs
// from this user's running processes (the session where start.sh works has
// them), then plain sockets with various authority guesses, then headless
// xvfb-run. Only then: error with guidance.
function testAttempt(card, { display, xauthority, viaXvfb, env: baseEnv }) {
  return new Promise((resolve) => {
    const env = baseEnv ? { ...baseEnv } : { ...process.env };
    let cmd = path.join(card.finalDir, 'start.sh');    // the port's own launcher:
    // --no-sandbox: cwd semantics + GDK/fontconfig hardening. The three
    // backgrounding flags: Chromium throttles rAF for occluded/unfocused
    // windows — the game opens BEHIND RPGLPort during a test — which
    // fake-freezes the page and corrupts the frame-time diagnostic.
    let args = ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
    if (viaXvfb) {
      cmd = 'xvfb-run';
      args = ['-a', path.join(card.finalDir, 'start.sh'), ...args];
    } else {
      if (display) env.DISPLAY = display;
      if (xauthority) env.XAUTHORITY = xauthority;
    }
    let fatal = '';
    const p = spawn(cmd, args, { cwd: card.finalDir, stdio: ['ignore', 'ignore', 'pipe'], env });
    p.on('error', (e) => resolve({ kind: 'error', msg: e.message }));
    p.stderr.on('data', (c) => { fatal += c; });
    const t = setTimeout(() => {
      // alive is not enough: a legacy runtime can idle forever with no window
      // and no output — only a spawned renderer proves the game actually began.
      // Snapshot BEFORE the kill: SIGTERM starts Chromium shutdown and the
      // renderer children vanish within milliseconds — reading after the kill
      // misreports a healthy windowed launch as no-window (seen on desktop).
      const ok = procs.descendantCmdline(p.pid, '--type=renderer');
      p.kill('SIGTERM');
      resolve({ kind: ok ? 'ok' : 'no-window', viaXvfb });
    }, 8000);
    p.on('close', (code, signal) => {
      clearTimeout(t);
      if (signal === 'SIGTERM') resolve({ kind: 'ok', viaXvfb });          // external SIGTERM before our timer — treat as before
      else if (/cannot open display/i.test(fatal)) resolve({ kind: 'no-display', fatal, code });
      else if (code === 0 || code === null) resolve({ kind: 'exited-early', fatal, code }); // self-exit ≠ launched (e.g. launcher-integrity DRM)
      else resolve({ kind: 'crashed', fatal, code });
    });
  });
}

// Test-Run diagnostic: a temporary, self-contained probe appended to the
// port's index.html. It records which scene (if any) the page reached, the
// real WebGL renderer string (llvmpipe/SwiftShader = GPU init failed, which
// is exactly the "very laggy" report), and rAF frame-time spread (median/max
// quantifies the periodic freezes). Restored in doTestRun's finally.
function injectDiagProbe(card) {
  const idx = ['www/index.html', 'index.html']
    .map(rel => path.join(card.finalDir, rel))
    .find(p => fs.existsSync(p));
  if (!idx) return null;
  const marker = path.join(card.finalDir, '.rpglport-diag.txt');
  let orig;
  try { orig = fs.readFileSync(idx, 'utf8'); } catch { return null; }
  const PROBE = '<script>(function(){try{var fs=require("fs"),MARK=' + JSON.stringify(marker) + ';' +
    'function w(s){try{fs.writeFileSync(MARK,s)}catch(e){}}' +
    'function st(a){var b=a.slice().sort(function(x,y){return x-y});return [Math.round(b[b.length>>1]||0),Math.round(b[b.length-1]||0)];}' +
    'var scene="none",r="not-read-yet",n=0,t0=0,t00=0,tN=0,d=[],sc=0,_oe=window.onerror;' +
    // The renderer string must come from the GAME's own GL context
    // (Graphics._renderer.gl). A probe-owned WebGL context wedges the
    // compositor frame pump on some stacks (measured: healthy 60fps
    // collapses to a burst + starvation with 0ms deltas) — never make one.
    'function readR(){if(r!=="not-read-yet")return;' +
    'try{var g=window.Graphics&&Graphics._renderer&&Graphics._renderer.gl;if(!g)return;' +
    'var dbg=g.getExtension("WEBGL_debug_renderer_info");' +
    'r=String((dbg&&g.getParameter(dbg.UNMASKED_RENDERER_WEBGL))||g.getParameter(g.RENDERER)||"webgl-unknown").replace(/[\\n\\r]+/g," ");}catch(e){r="renderer-error";}}' +
    'function line(){readR();var m=st(d);return "scene="+scene+"\\nrenderer="+r+"\\nframes="+d.length+" med="+m[0]+" max="+m[1]+" span="+(tN?Math.round(tN-t00):0);}' +
    // append-mode: Diag play keeps the game open for a whole session, so the
    // marker is a log (capped); every flush appends, stalls append instantly
    'function flush(){try{if(fs.statSync(MARK).size>131072)fs.writeFileSync(MARK,"");}catch(e){}w(line()+"\\n");}' +
    'requestAnimationFrame(function f(){var t=performance.now();var dt=t0?t-t0:0;if(t0)d.push(dt);t0=t;if(!t00)t00=t;tN=t;' +
    'if(dt>=1000&&sc<50){sc++;try{fs.appendFileSync(MARK,"stall ms="+Math.round(dt)+" frame="+n+"\\n");}catch(e){}}' +
    'if(window.SceneManager&&SceneManager._scene)scene=SceneManager._scene.constructor.name;' +
    'if(++n%60===0)flush();if(n<2000000)requestAnimationFrame(f);});' +
    'window.onerror=function(m){w(line()+"\\nerror="+String(m).slice(0,200));if(_oe)return _oe.apply(this,arguments);};' +
    '}catch(e){}})();</script>';
  const injected = orig.replace(/<\/body>/i, PROBE + '</body>');
  if (injected === orig) return null;
  try { fs.writeFileSync(idx, injected); } catch { return null; }
  try { fs.unlinkSync(marker); } catch {}
  return {
    marker,
    restore() {
      try { fs.writeFileSync(idx, orig); } catch { /* best effort */ }
      try { fs.unlinkSync(marker); } catch {}
    },
  };
}

function readDiag(marker) {
  try {
    const d = procs.parseDiag(fs.readFileSync(marker, 'utf8'));
    return d.frames || d.scene !== 'none' ? d : null;
  } catch { return null; }
}

const envSummary = (env) =>
  `DISPLAY=${env.DISPLAY || '(unset)'} XAUTHORITY=${env.XAUTHORITY ? 'set' : 'unset'} WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY || '(unset)'} XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR || '(unset)'} GDK_BACKEND=${env.GDK_BACKEND || '(unset)'}`;

// Old Chromium's GLX present path cannot obtain vsync under XWayland; the
// game then free-runs at unthrottled fps (MV logic runs too fast) or stalls
// for seconds (input lag, frozen cutscenes) and tears. Seen as repeated
// "GetVSyncParametersIfAvailable() failed" lines in game stderr.
function logVsyncHint(card, fatal) {
  if (/GetVSyncParametersIfAvailable\(\) failed/.test(fatal)) {
    appendLog(card.id, 'vsync unavailable: this runtime\'s GL present path fails under XWayland — expect stutter, tearing, speed drift. Try re-porting with the newest runtime in the dropdown (host 0.115.x), or launch with --use-angle=vulkan');
  }
}

async function doTestRun(card) {
  if (!card.finalDir) return;
  setStatus(card, 'test run…');
  appendLog(card.id, `tool environment: ${envSummary(process.env)}`);
  const diag = injectDiagProbe(card);
  try {
    // attempt 0: the tool's own environment, unchanged (right on normal desktops)
    let r = await testAttempt(card, {});
    // stderr is evidence even on success: gpu-process crash loops (periodic
    // freezes) and driver spew land here while the verdict looks healthy
    if (r.fatal && r.fatal.trim()) {
      appendLog(card.id, `game stderr (tail): ${r.fatal.trimEnd().slice(-500)}`);
      logVsyncHint(card, r.fatal);
    }
    const d = diag && readDiag(diag.marker);
    if (d) {
      appendLog(card.id, `page diag: scene=${d.scene} renderer=${d.renderer} frames=${d.frames} med=${d.med}ms max=${d.max}ms span=${d.span}ms${d.error ? ` error=${d.error}` : ''}`);
      if (r.kind === 'no-window' && /^Scene_/.test(d.scene)) {
        appendLog(card.id, 'renderer check found no window but the page reached a scene — treating as launched (probe wins)');
        r = { kind: 'ok', viaXvfb: r.viaXvfb };
      }
    }
    if (r.kind === 'ok') {
      const sw = d && /llvmpipe|swiftshader|softpipe|software rasterizer/i.test(d.renderer);
      if (sw) setStatus(card, `launched OK — SOFTWARE rendering (${d.renderer}): GPU init failed, this causes input lag and freezes`, 'warn');
      else setStatus(card, 'launched OK (window rendering)', 'done');
      return;
    }
    if (r.kind === 'no-window') {
      setStatus(card, 'game process stayed alive but no window ever opened (renderer never spawned) — usually the runtime cannot initialize graphics on this system; see NOTES.txt', 'error');
      appendLog(card.id, 'test-run: alive at 8s but no --type=renderer descendant — silent no-window');
      return;
    }
    if (r.kind === 'error') return setStatus(card, `test run failed: ${r.msg}`, 'error');
    if (r.kind === 'exited-early') {
      setStatus(card, `the game exited by itself right after launch (code ${r.code ?? 0}) — see NOTES.txt: possible launcher-integrity check`, 'error');
      appendLog(card.id, `test-run early self-exit ${r.code}: ${r.fatal.slice(-500)}`);
      return;
    }
    if (r.kind === 'crashed') {
      const line = (r.fatal.match(/FATAL:[^\n]*|Check failed[^\n]*/) || [])[0] || `exit ${r.code}`;
      setStatus(card, `crashed: ${line}`, 'error');
      appendLog(card.id, `test-run exit ${r.code}: ${r.fatal.slice(-500)}`);
      return;
    }
    // no-display. The pair-based retries below carry the tool's inherited env —
    // which may itself be poisoned for X (a correct DISPLAY+XAUTHORITY can still
    // be rejected when e.g. GDK_BACKEND/WAYLAND_DISPLAY/XDG_RUNTIME_DIR are
    // stale). So FIRST adopt whole working environments from session processes
    // (the shell where start.sh works holds one), then fall back to pairs.
    const live = new Set(await findLiveDisplays());
    const sessions = findSessionEnvs('/proc', live);
    appendLog(card.id, `display ${process.env.DISPLAY || '(unset)'} unreachable — ${sessions.length} session env(s), then pair candidates`);
    for (const s of sessions) {
      const env = { ...s.env };
      if (!env.PATH) env.PATH = process.env.PATH;
      appendLog(card.id, `adopting env of ${s.comm || 'process'} (pid ${s.pid}): ${envSummary(env)}`);
      r = await testAttempt(card, { env });
      if (r.kind === 'ok') {
        setStatus(card, `launched OK — adopted environment of ${s.comm || 'session'} (pid ${s.pid})`, 'done');
        appendLog(card.id, `booted with adopted env: ${envSummary(env)}`);
        return;
      }
      if (r.kind === 'no-window') {
        setStatus(card, 'game process stayed alive but no window ever opened (renderer never spawned) — usually the runtime cannot initialize graphics on this system; see NOTES.txt', 'error');
        appendLog(card.id, 'test-run: alive at 8s but no --type=renderer descendant — silent no-window');
        return;
      }
      if (r.kind === 'crashed') {
        const line = (r.fatal.match(/FATAL:[^\n]*|Check failed[^\n]*/) || [])[0] || `exit ${r.code}`;
        setStatus(card, `crashed: ${line}`, 'error');
        appendLog(card.id, `test-run exit ${r.code}: ${r.fatal.slice(-500)}`);
        return;
      }
      if (r.kind === 'exited-early') {
        setStatus(card, `the game exited by itself right after launch (code ${r.code ?? 0}) — see NOTES.txt: possible launcher-integrity check`, 'error');
        appendLog(card.id, `test-run early self-exit ${r.code}: ${r.fatal.slice(-500)}`);
        return;
      }
      if (r.kind === 'error') return setStatus(card, `test run failed: ${r.msg}`, 'error');
      const xlib = (r.fatal.match(/Xlib:[^\n]*/) || [])[0] || 'cannot open display';
      appendLog(card.id, `adopted env rejected: ${xlib.trim()}`);
    }
    // pair-based fallback (environments without /proc-visible session processes)
    const auths = new Set();
    for (const p of findProcDisplayPairs()) if (p.xauthority) auths.add(p.xauthority);
    if (process.env.XAUTHORITY) auths.add(process.env.XAUTHORITY);
    for (const a of xauthorityCandidates()) auths.add(a);
    const candidates = [];
    const seen = new Set();
    const push = (display, xauthority) => {
      const key = `${display}|${xauthority || ''}`;
      if (!seen.has(key)) { seen.add(key); candidates.push({ display, xauthority }); }
    };
    for (const p of findProcDisplayPairs().filter(p => live.has(p.display))) push(p.display, p.xauthority);
    for (const d2 of live) {
      for (const a of auths) push(d2, a);
      push(d2, null);
    }
    for (const c of candidates) {
      r = await testAttempt(card, c);
      if (r.kind === 'ok') {
        setStatus(card, `launched OK on ${c.display}${c.xauthority ? ' (session authority)' : ''}`, 'done');
        appendLog(card.id, `booted with DISPLAY=${c.display}${c.xauthority ? ` XAUTHORITY=${c.xauthority}` : ''}`);
        return;
      }
      if (r.kind === 'no-window') {
        setStatus(card, 'game process stayed alive but no window ever opened (renderer never spawned) — usually the runtime cannot initialize graphics on this system; see NOTES.txt', 'error');
        appendLog(card.id, 'test-run: alive at 8s but no --type=renderer descendant — silent no-window');
        return;
      }
      if (r.kind === 'crashed') {
        const line = (r.fatal.match(/FATAL:[^\n]*|Check failed[^\n]*/) || [])[0] || `exit ${r.code}`;
        setStatus(card, `crashed: ${line}`, 'error');
        appendLog(card.id, `test-run exit ${r.code}: ${r.fatal.slice(-500)}`);
        return;
      }
      if (r.kind === 'exited-early') {
        setStatus(card, `the game exited by itself right after launch (code ${r.code ?? 0}) — see NOTES.txt: possible launcher-integrity check`, 'error');
        appendLog(card.id, `test-run early self-exit ${r.code}: ${r.fatal.slice(-500)}`);
        return;
      }
      if (r.kind === 'error') return setStatus(card, `test run failed: ${r.msg}`, 'error');
      const xlib = (r.fatal.match(/Xlib:[^\n]*/) || [])[0] || 'cannot open display';
      appendLog(card.id, `candidate ${c.display}${c.xauthority ? ` (${c.xauthority})` : ' (no authority)'} rejected: ${xlib.trim()}`);
    }
    if (hasXvfbRun()) {
      appendLog(card.id, 'no usable local display — retrying headless under xvfb-run');
      r = await testAttempt(card, { viaXvfb: true });
      if (r.fatal && r.fatal.trim()) appendLog(card.id, `game stderr (tail): ${r.fatal.trimEnd().slice(-500)}`);
      if (r.kind === 'ok') return setStatus(card, 'launched OK headless (Xvfb — no window shown)', 'done');
      if (r.kind === 'no-window') {
        setStatus(card, 'no window even headless: process alive but the renderer never spawns — runtime cannot initialize graphics on this system; see NOTES.txt', 'error');
        appendLog(card.id, 'test-run xvfb: alive at 8s but no --type=renderer descendant — silent no-window');
        return;
      }
    }
    setStatus(card, 'no usable display found — restart RPGLPort from the session where start.sh works (or install Xvfb on headless machines)', 'error');
    appendLog(card.id, 'all display candidates rejected');
  } finally {
    if (diag) diag.restore();
  }
}

// Diag play: launch the port with the diagnostic probe and let the user
// actually PLAY until the problem shows up — the probe records frame-time
// stats plus every ≥1s stall as it happens. Data is collected when the user
// closes the game (15 min safety cap). Test Run's 8s window only ever sees
// the title screen; gameplay-only lag needs a real session.
async function doDiagRun(card) {
  if (!card.finalDir) return;
  const diag = injectDiagProbe(card);
  if (!diag) { setStatus(card, 'diag play: could not inject the diagnostic probe into this port', 'error'); return; }
  setStatus(card, 'diag play running — play until the problem shows, then close the game');
  appendLog(card.id, 'diag play: launched with the diagnostic probe — freezes ≥1s are recorded; close the game to collect the report');
  try {
    const r = await new Promise((resolve) => {
      const env = { ...process.env };
      const p = spawn(path.join(card.finalDir, 'start.sh'),
        ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
        { cwd: card.finalDir, stdio: ['ignore', 'ignore', 'pipe'], env });
      let fatal = '';
      p.stderr.on('data', (c) => { fatal += c; });
      const cap = setTimeout(() => p.kill('SIGKILL'), 15 * 60e3);
      p.on('close', (code, signal) => { clearTimeout(cap); resolve({ code, signal, fatal }); });
      p.on('error', (e) => { clearTimeout(cap); resolve({ code: null, signal: null, fatal: `spawn: ${e.message}` }); });
    });
    if (r.fatal && r.fatal.trim()) {
      appendLog(card.id, `game stderr (tail): ${r.fatal.trimEnd().slice(-500)}`);
      logVsyncHint(card, r.fatal);
    }
    const d = readDiag(diag.marker);
    if (!d || !d.frames) {
      setStatus(card, r.signal === 'SIGKILL' ? 'diag play: 15 min cap reached before the game reported frames' : 'diag play: the page never reported frames — see log', 'error');
      appendLog(card.id, `diag play: no frame data (exit code ${r.code}, signal ${r.signal})`);
      return;
    }
    appendLog(card.id, `diag play report: scene=${d.scene} renderer=${d.renderer} frames=${d.frames} med=${d.med}ms max=${d.max}ms span=${d.span}ms${d.error ? ` error=${d.error}` : ''}`);
    for (const s of d.stalls) appendLog(card.id, `diag stall: ${s}`);
    setStatus(card, `diag play done — ${d.frames} frames, med ${d.med}ms, max ${d.max}ms${d.stalls.length ? `, ${d.stalls.length} stall(s) ≥1s (see log)` : ', no ≥1s stalls'}`, d.stalls.length ? 'warn' : 'done');
  } finally {
    diag.restore();
  }
}

/* wiring */
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const items = [...(e.dataTransfer.files || [])].map(f => f.path);
  if (items.length) addInputs(items);
});
$('#filePick').onchange = () => addInputs([...$('#filePick').files].map(f => f.path));
$('#btnPick').onclick = () => { const inp = $('#filePick'); inp.value = ''; inp.click(); };
$('#btnSettings').onclick = () => {
  $('#setOutDir').value = state.settings.outDir;
  $('#setKeepExtracted').checked = !!state.settings.keepExtracted;
  refreshPool();
  $('#settingsDlg').showModal();
};
$('#setSave').onclick = () => {
  state.settings = { outDir: $('#setOutDir').value || state.settings.outDir, keepExtracted: $('#setKeepExtracted').checked };
  settings.save(state.settings);
  $('#settingsDlg').close();
  toast('settings saved');
};
$('#setClose').onclick = () => $('#settingsDlg').close();
$('#btnImport').onclick = async () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.gz,.tgz';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    let dest = path.join(require('os').homedir(), '.cache', 'rpglport', 'runtimes');
    try {
      const bundled = path.join(ROOT, 'runtimes');
      fs.accessSync(path.join(ROOT, 'runtimes'), fs.constants.W_OK);        // throws when read-only
      dest = bundled;
    } catch { /* keep user cache dir */ }
    fs.mkdirSync(dest, { recursive: true });
    const { extractArchive } = require('./core/extract');
    const r = await extractArchive(SZ, f.path, dest);
    toast(r.ok ? 'runtime imported' : 'import failed', r.ok ? '' : 'err');
    refreshPool();
  };
  inp.click();
};

(async () => {
  await refreshPool();
  const st = await selftest(ROOT);
  if (!st.ok) toast(`selftest failed: ${st.checks.filter(c => !c.ok).map(c => c.name).join(', ')}`, 'err');
})();
