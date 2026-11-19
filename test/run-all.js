// Runs every check in test/, one after another, and says which passed. Run: npm test
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const checks = fs.readdirSync(__dirname).filter((f) => /-check\.js$/.test(f));
const results = [];
for (const f of checks) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  results.push([f, r.status === 0]);
}
console.log('\n' + results.map(([f, ok]) => `${ok ? '✓' : '✗'} ${f}`).join('\n'));
process.exitCode = results.every(([, ok]) => ok) ? 0 : 1;
