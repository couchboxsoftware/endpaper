// Publishes a new Endpaper version to GitHub Releases, where the app's updater finds it.
//
//   npm run release -- 0.1.1
//
// 1. Checks CHANGELOG.md has an entry for the version (that entry becomes the release notes,
//    the "Update available" banner text and What's new).
// 2. Sets the version in package.json, builds the installer (dist/Endpaper-Setup-x.y.z.exe).
// 3. Commits, tags vX.Y.Z, pushes, and creates the GitHub release with the installer,
//    latest.yml and the blockmap (electron-updater needs all three).
//
// Needs Git and the GitHub CLI, signed in once with: gh auth login
// --dry-run builds and prints the notes without committing or publishing.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a)) || pkg.version;

const fail = (msg) => {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
};
const tool = (name, fallback) => {
  for (const c of [name, fallback]) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {}
  }
  return null;
};
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: ROOT, stdio: 'inherit', ...opts });
const out = (cmd, a) => execFileSync(cmd, a, { cwd: ROOT, encoding: 'utf8' }).trim();

/* ---------- release notes from the changelog ---------- */
function notesFor(v) {
  const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^## ${v.replace(/\./g, '\\.')} · `).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  const date = lines[start].split(' · ')[1];
  return { date, body };
}

const notes = notesFor(version);
if (!notes) fail(`CHANGELOG.md has no entry for ${version}. Add one at the top first, like:\n\n## ${version} · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}\nOne short sentence: what you'll notice.\n\n### New\n- ...`);
const first = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '').match(/^## (\S+) · /m);
if (first && first[1] !== version) fail(`The newest entry in CHANGELOG.md is ${first[1]}, not ${version}. Put the ${version} entry at the top.`);

const git = tool('git', 'C:\\Program Files\\Git\\cmd\\git.exe');
const gh = tool('gh', 'C:\\Program Files\\GitHub CLI\\gh.exe');
if (!dry) {
  if (!git) fail('Git isn\'t installed. Install it with: winget install Git.Git');
  if (!gh) fail('The GitHub CLI isn\'t installed. Install it with: winget install GitHub.cli');
  try {
    execFileSync(gh, ['auth', 'status'], { stdio: 'ignore' });
  } catch {
    fail('The GitHub CLI isn\'t signed in. Run: gh auth login');
  }
  const status = out(git, ['status', '--porcelain']).split('\n').filter((l) => l && !/package\.json$|CHANGELOG\.md$/.test(l));
  if (status.length) fail(`There are changes that aren't committed:\n${status.join('\n')}\nCommit them first, so the release matches the code on GitHub.`);
  try {
    execFileSync(git, ['rev-parse', '-q', '--verify', `refs/tags/v${version}`], { cwd: ROOT, stdio: 'ignore' });
    fail(`v${version} has already been released. Use a new version number.`);
  } catch (e) {
    if (e.status === undefined) throw e;
  }
}

/* ---------- build ---------- */
if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Version set to ${version}.`);
}
console.log(`\nBuilding Endpaper ${version}…\n`);
run(process.execPath, [require.resolve('electron-builder/cli.js'), '--win', '--publish', 'never']);

const dist = path.join(ROOT, 'dist');
const exe = `Endpaper-Setup-${version}.exe`;
const files = [exe, `${exe}.blockmap`, 'latest.yml'].map((f) => path.join(dist, f));
for (const f of files) if (!fs.existsSync(f)) fail(`The build didn't make ${path.basename(f)}.`);
const notesFile = path.join(dist, `release-notes-${version}.md`);
fs.writeFileSync(notesFile, notes.body + '\n');
console.log(`\nRelease notes:\n\n${notes.body}\n`);

if (dry) {
  console.log(`Dry run: built ${exe}. Nothing was committed or published.`);
  process.exit(0);
}

/* ---------- publish ---------- */
run(git, ['add', 'package.json', 'CHANGELOG.md']);
try {
  execFileSync(git, ['diff', '--cached', '--quiet'], { cwd: ROOT });
} catch {
  run(git, ['commit', '-m', `Release ${version}`]);
}
run(git, ['tag', '-a', `v${version}`, '-m', `Endpaper ${version}`]);
run(git, ['push', '--follow-tags']);
run(gh, ['release', 'create', `v${version}`, ...files, '--title', `Endpaper ${version}`, '--notes-file', notesFile]);
console.log(`\n✓ Endpaper ${version} is released. Installed copies will offer the update within a few hours, or straight away from Settings, App, Check for updates.\n`);
