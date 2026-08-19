'use strict';
const test = require('node:test');
const assert = require('node:assert');
const map = require('../app/core/nwmap.json');

test('nwmap has expected entries and reverse lookups', () => {
  assert.equal(map.versions['0.29.0'].node, '9.7.1');
  assert.equal(map.versions['0.29.0'].chromium, '65.0.3325.146');
  assert.equal(map.versions['0.48.4'].node, '14.12.0');
  assert.equal(map.versions['0.48.4'].chromium, '85.0.4183.121');
  assert.equal(map.byNode['9.7.1'], '0.29.0');          // 9.7.1 is unique to 0.29.0
  assert.ok(map.byNode['14.12.0'].startsWith('0.4'));   // 0.48.3/0.48.4/0.49.0 all ship it — stable-map only
  assert.ok(!map.byNode['14.12.0'].includes('beta'));   // betas never win reverse maps
  assert.ok(Object.keys(map.versions).length >= 300);
  // integrity: every reverse entry round-trips
  for (const [node, v] of Object.entries(map.byNode))
    assert.equal(map.versions[v].node, node, `byNode ${node}`);
});
