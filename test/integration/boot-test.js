'use strict';
// Integration: port every fixture game and boot it headless, asserting the
// title scene. Run: RPGLPORT_IT=1 node test/integration/boot-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { analyze, cmpVer } = require('../../app/core/detect');
const { listPool, choose } = require('../../app/core/select');
const { scan } = require('../../app/core/casescan');
const { buildPort } = require('../../app/core/port');
const { fixtureDirs } = require('../helpers/fixtures');

// Known pre-existing game bugs tolerated in the errors= line (present on Windows too).
// The probe records "message @ source-url" so file-targeted patterns can match;
// PluginManagerEx must come from FloatVariables.js specifically (verified format:
// "Uncaught ReferenceError: PluginManagerEx is not defined @ chrome-extension://<id>/www/js/plugins/FloatVariables.js").
const TOLERATED = [/FPS\.js/, /PluginManagerEx is not defined @ .*plugins\/FloatVariables\.js/];

function bootTest(portDir, win, script = 'start.sh', extraFlags = []) {
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
    const nw = spawn(path.join(portDir, script), ['--no-sandbox', ...extraFlags], { cwd: portDir, stdio: ['ignore', 'ignore', errLog], env: { ...process.env, DISPLAY: win } });
    const deadline = Date.now() + 90e3;
    const iv = setInterval(() => {
      if (fs.existsSync(marker)) { clearInterval(iv); nw.kill('SIGKILL'); resolve(fs.readFileSync(marker, 'utf8')); }
      else if (Date.now() > deadline) { clearInterval(iv); nw.kill('SIGKILL'); resolve('HARNESS-TIMEOUT'); }
    }, 1000);
  }).finally(() => { fs.writeFileSync(idx, orig); fs.closeSync(errLog); });
}

// Known container-environment failures (llvmpipe) — NOT port bugs. Each has a
// control experiment proving the original payload fails identically, or a
// desktop-run pass on record:
// - Twisted Prison of Lust: a plugin spins the renderer on software GL; a port
//   with an EMPTY fix plan fails the same way (session 1.0.17 investigation).
// - 合法レ●プの旅: pixi-4 (WebGL1-era) crashes on Chromium 152's WebGL2 path
//   under llvmpipe; the 0.48.4 port boots and the user plays it on desktop.
const CONTAINER_BROKEN = [/Twisted Prison of Lust/i, /合法レ/];

function evaluate(out) {
  const scene = (out.match(/scene=(\S+)/) || [])[1] || '';
  const errors = (out.match(/errors=(.*)/) || [])[1] || 'unknown';
  const okScene = scene === 'Scene_Boot' || /^Scene_Title/.test(scene); // custom title scenes (e.g. Scene_TitleMap) count
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
    const FIXTURES = fixtureDirs();
    if (!FIXTURES.length) console.log('no live fixtures (set RPGLPORT_TEST_GAMES)');
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
      // Modern-Chromium runtimes need two container-workarounds that are ONLY
      // about this lab (real desktops are unaffected): llvmpipe is WebGL1-
      // blocklisted (MV is a WebGL1 engine → no scene ever), and the 64 MiB
      // /dev/shm cannot back Chromium's font-data shared memory (FATAL ENOSPC).
      const modern = cmpVer(pick.runtime.version, '0.49.0') > 0;
      const extra = modern ? ['--ignore-gpu-blocklist', '--disable-dev-shm-usage'] : [];
      const out = await bootTest(r.finalDir, ':97', 'start.sh', extra);
      const v = evaluate(out);
      if (CONTAINER_BROKEN.some(re => re.test(path.basename(game)))) {
        console.log('SKIP (known llvmpipe limitation, desktop-verified)', path.basename(game), '→', v.scene, '|', v.errors);
        continue;
      }
      // Isolated profile guard: every runtime in the pool must honor
      // XDG_CONFIG_HOME or the shared-profile poisoning bug returns.
      const isolated = fs.existsSync(path.join(r.finalDir, '.userdata'));
      v.ok = v.ok && isolated;
      if (!isolated) console.error('NO ISOLATED PROFILE (.userdata missing):', path.basename(game));
      console.log(v.ok ? 'PASS' : 'FAIL', path.basename(game), '→', v.scene, '|', v.errors);
      if (!v.ok) { console.error('port dir (kept for debugging until base cleanup):', r.finalDir); failed++; }
      // Variant launchers (multi-language games): boot one variant end-to-end —
      // start-E.sh → start.sh → wrapper → nw_E hardlink exec chain must work.
      const firstVariant = fs.readdirSync(r.finalDir).filter(f => /^start-.+\.sh$/.test(f)).sort()[0];
      if (firstVariant) {
        const outV = await bootTest(r.finalDir, ':97', firstVariant, extra);
        const vV = evaluate(outV);
        console.log(vV.ok ? 'PASS' : 'FAIL', path.basename(game), `[${firstVariant}]`, '→', vV.scene, '|', vV.errors);
        if (!vV.ok) failed++;
      }
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
