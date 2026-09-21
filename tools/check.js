#!/usr/bin/env node
// Runs the handover's acceptance checks (section 6) against data/turnover-data.json without a browser.
const path = require('path');
const { calc } = require(path.join(__dirname, '..', 'app.js'));
const D = require(path.join(__dirname, '..', 'data', 'turnover-data.json'));
const results = calc.selfCheck(D);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${JSON.stringify(r.got)}${r.ok ? '' : '  expected ' + JSON.stringify(r.want)}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
