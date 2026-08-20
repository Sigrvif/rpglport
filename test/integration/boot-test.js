'use strict';
// Integration: port every fixture game and boot it headless, asserting the
// title scene. Run: RPGLPORT_IT=1 node test/integration/boot-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { analyze } = require('../../app/core/detect');
const { listPool, choose } = require('../../app/core/select');
const { scan } = require('../../app/core/casescan');
const { buildPort } = require('../../app/core/port');
const { FIXTURES } = require('../helpers/fixtures');

// Known pre-existing game bugs tolerated in the errors= line (present on Windows too).
// The probe records "message @ source-url" so file-targeted patterns can match;
// PluginManagerEx must come from FloatVariables.js specifically (verified format:
// "Uncaught ReferenceError: PluginManagerEx is not defined @ chrome-extension://<id>/www/js/plugins/FloatVariables.js").
const TOLERATED = [/FPS\.js/, /PluginManagerEx is not defined @ .*plugins\/FloatVariables\.js/];

function bootTest(portDir, win) {
  const idx = fs.existsSync(path.join(portDir, 'www', 'index.html'))
    ? path.join(portDir, 'www', 'index.html') : path.join(portDir, 'index.html');
  const marker = path.join(portDir, '__BOOT__.txt');     // absolute path embedded in the probe — cwd-relative won't do
  const PROBE = `<script>(function(){var w=require('fs');var MARK=${JSON.stringify(marker)};window.__e=[];window.onerror=function(m,s){window.__e.push(String(m)+' @ '+String(s))};
var t=0;(function p(){setTimeout(function(){var s=window.SceneManager&&SceneManager._scene;
if(s&&/Title|Boot/.test(s.constructor.name)&&window.$dataSystem){w.writeFileSync(MARK,'scene='+s.constructor.name+'\\nerrors='+(window.__e.length?window.__e.slice(0,10).join('|'):'none'));return;}
if(++t>20){w.writeFileSync(MARK,'TIMEOUT scene='+(s?s.constructor.name:'none'));return;}p();},3000);})();})();</script>`;
  const orig = fs.readFileSync(idx, 'utf8');
  const injected = orig.replace('</body>', PROBE + '</body>');
  if (injected === orig) throw new Error(`probe injection failed (no </body> in ${idx})`);
  fs.writeFileSync(idx, injected);
  try { fs.unlinkSync(marker); } catch {}
  const errLog = fs.openSync(marker + '.stderr.log', 'w');
  return new Promise((resolve) => {
    // Launch through start.sh — the user-facing path (cd + exec ./nw),
    // which exercises the wrapper with a RELATIVE $0: old fontconfig ignores
    // a relative FONTCONFIG_FILE, so this pins the wrapper's absolutization.
    const nw = spawn(path.join(portDir, 'start.sh'), ['--no-sandbox'], { cwd: portDir, stdio: ['ignore', 'ignore', errLog], env: { ...process.env, DISPLAY: win } });
    const deadline = Date.now() + 90e3;
    const iv = setInterval(() => {
      if (fs.existsSync(marker)) { clearInterval(iv); nw.kill('SIGKILL'); resolve(fs.readFileSync(marker, 'utf8')); }
      else if (Date.now() > deadline) { clearInterval(iv); nw.kill('SIGKILL'); resolve('HARNESS-TIMEOUT'); }
    }, 1000);
  }).finally(() => { fs.writeFileSync(idx, orig); fs.closeSync(errLog); });
}

function evaluate(out) {
  const scene = (out.match(/scene=(\S+)/) || [])[1] || '';
  const errors = (out.match(/errors=(.*)/) || [])[1] || 'unknown';
  const okScene = scene === 'Scene_Title' || scene === 'Scene_Boot';
  const errs = errors === 'none' ? [] : errors.split('|');
  const okErrors = errs.every(e => TOLERATED.some(re => re.test(e)));
  return { ok: okScene && okErrors, scene, errors };
}

async function main() {
  if (process.env.RPGLPORT_IT !== '1') { console.log('skip: set RPGLPORT_IT=1'); return; }
  const assert = require('node:assert');
  const { pool } = listPool(path.join(__dirname, '..', '..'));
  assert(pool.length >= 6, 'pool missing runtimes');
  if (spawnSync('sh', ['-c', 'command -v Xvfb'], { stdio: 'ignore' }).status !== 0) {
    console.error('Xvfb not available'); process.exit(1);
  }
  const xvfb = spawn('Xvfb', [':97', '-screen', '0', '1280x810x24'], { stdio: 'ignore' });
  xvfb.on('error', (e) => { console.error('Xvfb spawn failed:', e.message); process.exit(1); });
  await new Promise(r => setTimeout(r, 1500));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rpglport-it-'));
  let failed = 0;
  try {
    for (const game of FIXTURES) {
      if (!fs.existsSync(game)) { console.log('skip (absent):', game); continue; }
      const info = analyze(game);
      const pick = choose(pool, info.detectedNW, info.engine, info.engineVersion);
      if (pick.refused) { console.error('REFUSED', game, pick.refused); failed++; continue; }
      const sc = scan(info.payloadRoot);
      if (sc.conflicts.length) { console.error('CONFLICTS', game, sc.conflicts); failed++; continue; }
      const r = await buildPort({
        gameDir: game, info, scan: sc, runtimeDir: pick.runtime.path,
        runtimeVersion: pick.runtime.version,
        outParent: base, dirName: path.basename(game).slice(0, 40) + ' (Linux)', onExists: 'newname',
      });
      const out = await bootTest(r.finalDir, ':97');
      const v = evaluate(out);
      console.log(v.ok ? 'PASS' : 'FAIL', path.basename(game), '→', v.scene, '|', v.errors);
      if (!v.ok) { console.error('port dir (kept for debugging until base cleanup):', r.finalDir); failed++; }
    }
  } finally {
    xvfb.kill();
    // base is only needed during the loop; remove it here (finally runs after
    // the loop completes) so port dirs + stderr logs never linger in /tmp.
    fs.rmSync(base, { recursive: true, force: true });
  }
  if (failed) { console.error(`${failed} fixture(s) failed`); process.exit(1); }
  console.log('integration: all fixtures passed');
}
main().catch(e => { console.error(e); process.exit(1); });
