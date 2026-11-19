// Shared by the checks in test/. Each check file is two things at once:
//
//  - Run with Node (node test/startup-check.js), it's the runner: it makes a throwaway settings
//    folder, starts the real app with ENDPAPER_TEST pointing back at the same file and
//    ENDPAPER_TEST_USERDATA at that folder, and passes or fails on the PASS/FAIL lines it prints.
//  - Loaded by main.js (ENDPAPER_TEST), it exports the steps that drive the app from inside.
//
// Nothing here touches your real settings, files or registry.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- the runner side (plain Node) ---------- */

// A new, empty settings folder, optionally with a settings.json in it.
function tempUserData(name, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `endpaper-${name}-`));
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  return dir;
}

// Starts the app with a check script. Prints its PASS/FAIL lines as they come and resolves with
// what happened. env adds to (or, with null, removes from) the environment.
function launch(script, { userData, env = {}, timeout = 120000, label = '' } = {}) {
  return new Promise((resolve) => {
    const e = { ...process.env, ENDPAPER_TEST: script, ENDPAPER_TEST_USERDATA: userData };
    for (const [k, v] of Object.entries(env)) v === null ? delete e[k] : (e[k] = v);
    const started = Date.now();
    const child = spawn(ELECTRON, [ROOT], { cwd: ROOT, env: e, windowsHide: true });
    const lines = [];
    const take = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue;
        lines.push({ t: Date.now() - started, line });
        if (/^(PASS|FAIL|INFO)\b/.test(line) || /TEST FAILED/.test(line)) console.log(`${label ? label + ' ' : ''}${line}`);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      lines.push({ t: Date.now() - started, line: 'FAIL  the app was still running after ' + timeout / 1000 + 's' });
      console.log('FAIL  the app was still running after ' + timeout / 1000 + 's');
      child.kill();
    }, timeout);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, lines, ms: Date.now() - started, fails: lines.filter((l) => /^FAIL\b|TEST FAILED/.test(l.line)).length, passes: lines.filter((l) => /^PASS\b/.test(l.line)).length });
    });
  });
}

// Adds up the runs (and any checks the runner made itself), prints the total, sets the exit code.
function finish(name, runs, extra = { passes: 0, fails: 0 }) {
  const passes = runs.reduce((a, r) => a + r.passes, extra.passes);
  const fails = runs.reduce((a, r) => a + r.fails, extra.fails);
  const ok = fails === 0 && passes > 0;
  console.log(`\n${ok ? '✓' : '✗'} ${name}: ${passes} passed, ${fails} failed\n`);
  process.exitCode = ok ? 0 : 1;
  return ok;
}

// A PASS/FAIL line, for checks made outside the app (in the runner).
function runnerCheck() {
  const tally = { passes: 0, fails: 0 };
  const check = (name, ok, detail = '') => {
    ok ? tally.passes++ : tally.fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== '' ? '  -- ' + detail : ''}`);
    return ok;
  };
  return { check, tally };
}

/* ---------- the app side (inside main.js) ---------- */

// check(name, ok, detail) prints PASS or FAIL; waitFor polls a test until it's true.
function inApp({ exec }) {
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== '' ? '  -- ' + detail : ''}`);
    return ok;
  };
  async function waitFor(fn, ms = 10000, every = 100) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try {
        if (await fn()) return true;
      } catch (_) {}
      await wait(every);
    }
    return false;
  }
  // The page has started: App exists, the start screen or editor is showing.
  const appReady = () => waitFor(() => exec(`typeof App !== 'undefined' && !!App.S.version && (!document.getElementById('home').hidden || !document.getElementById('editor').hidden)`), 20000);
  return { check, waitFor, appReady, wait };
}

module.exports = { ROOT, ELECTRON, wait, tempUserData, launch, finish, runnerCheck, inApp };
