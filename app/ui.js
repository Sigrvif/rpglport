'use strict';
/* RPGLPort GUI — thin layer over app/core (NW.js: Node available in page). */
const path = require('path');
const fs = require('fs');
const { shell } = require('nw.gui');
const { analyzeInput, portCard, PortQueue, selftest, findLiveDisplays, hasXvfbRun, findProcDisplayPairs, xauthorityCandidates, findSessionEnvs } = require('./core/engine');
const { listPool, choose } = require('./core/select');
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
  return `${p.version} ${tag}`.trim();
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
  el.querySelector('.bOpen').onclick = () => card.finalDir && shell.showItemInFolder(card.finalDir);
  el.querySelector('.bTest').onclick = () => doTestRun(card);
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
    let args = ['--no-sandbox'];                       // cwd semantics + GDK/fontconfig hardening
    if (viaXvfb) {
      cmd = 'xvfb-run';
      args = ['-a', path.join(card.finalDir, 'start.sh'), '--no-sandbox'];
    } else {
      if (display) env.DISPLAY = display;
      if (xauthority) env.XAUTHORITY = xauthority;
    }
    let fatal = '';
    const p = spawn(cmd, args, { cwd: card.finalDir, stdio: ['ignore', 'ignore', 'pipe'], env });
    p.on('error', (e) => resolve({ kind: 'error', msg: e.message }));
    p.stderr.on('data', (c) => { fatal += c; });
    const t = setTimeout(() => { p.kill('SIGTERM'); resolve({ kind: 'ok', viaXvfb }); }, 8000);
    p.on('close', (code, signal) => {
      clearTimeout(t);
      if (signal === 'SIGTERM' || code === 0 || code === null) resolve({ kind: 'ok', viaXvfb });
      else if (/cannot open display/i.test(fatal)) resolve({ kind: 'no-display', fatal, code });
      else resolve({ kind: 'crashed', fatal, code });
    });
  });
}

const envSummary = (env) =>
  `DISPLAY=${env.DISPLAY || '(unset)'} XAUTHORITY=${env.XAUTHORITY ? 'set' : 'unset'} WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY || '(unset)'} XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR || '(unset)'} GDK_BACKEND=${env.GDK_BACKEND || '(unset)'}`;

async function doTestRun(card) {
  if (!card.finalDir) return;
  setStatus(card, 'test run…');
  appendLog(card.id, `tool environment: ${envSummary(process.env)}`);
  // attempt 0: the tool's own environment, unchanged (right on normal desktops)
  let r = await testAttempt(card, {});
  if (r.kind === 'ok') return setStatus(card, 'launched OK (no early crash)', 'done');
  if (r.kind === 'error') return setStatus(card, `test run failed: ${r.msg}`, 'error');
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
    if (r.kind === 'crashed') {
      const line = (r.fatal.match(/FATAL:[^\n]*|Check failed[^\n]*/) || [])[0] || `exit ${r.code}`;
      setStatus(card, `crashed: ${line}`, 'error');
      appendLog(card.id, `test-run exit ${r.code}: ${r.fatal.slice(-500)}`);
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
  for (const d of live) {
    for (const a of auths) push(d, a);
    push(d, null);
  }
  for (const c of candidates) {
    r = await testAttempt(card, c);
    if (r.kind === 'ok') {
      setStatus(card, `launched OK on ${c.display}${c.xauthority ? ' (session authority)' : ''}`, 'done');
      appendLog(card.id, `booted with DISPLAY=${c.display}${c.xauthority ? ` XAUTHORITY=${c.xauthority}` : ''}`);
      return;
    }
    if (r.kind === 'crashed') {
      const line = (r.fatal.match(/FATAL:[^\n]*|Check failed[^\n]*/) || [])[0] || `exit ${r.code}`;
      setStatus(card, `crashed: ${line}`, 'error');
      appendLog(card.id, `test-run exit ${r.code}: ${r.fatal.slice(-500)}`);
      return;
    }
    if (r.kind === 'error') return setStatus(card, `test run failed: ${r.msg}`, 'error');
    const xlib = (r.fatal.match(/Xlib:[^\n]*/) || [])[0] || 'cannot open display';
    appendLog(card.id, `candidate ${c.display}${c.xauthority ? ` (${c.xauthority})` : ' (no authority)'} rejected: ${xlib.trim()}`);
  }
  if (hasXvfbRun()) {
    appendLog(card.id, 'no usable local display — retrying headless under xvfb-run');
    r = await testAttempt(card, { viaXvfb: true });
    if (r.kind === 'ok') return setStatus(card, 'launched OK headless (Xvfb — no window shown)', 'done');
  }
  setStatus(card, 'no usable display found — restart RPGLPort from the session where start.sh works (or install Xvfb on headless machines)', 'error');
  appendLog(card.id, 'all display candidates rejected');
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
