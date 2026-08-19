'use strict';
// Persisted settings (spec §9). Single JSON file under ~/.config/rpgport/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const FILE = () => path.join(os.homedir(), '.config', 'rpgport', 'settings.json');
const DEFAULTS = { outDir: path.join(os.homedir(), 'RPGPort Games'), keepExtracted: false };

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function save(s) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify({ ...DEFAULTS, ...s }, null, 2));
}
module.exports = { load, save, DEFAULTS };
