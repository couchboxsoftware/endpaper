// Updates: Endpaper checks as soon as it opens (no waiting); the banner offers the update with
// its headline; Update now downloads it; with unsaved work it asks to save first, "Not now"
// waits, "Save and update" saves, remembers what to reopen, and stops just before installing.
// The runner serves a small stand-in "release" (latest.yml plus a fake installer with a matching
// checksum) from a local server, so nothing is downloaded from GitHub or installed.
// Run: node test/update-check.js
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const { check, tally } = H.runnerCheck();
    const current = require('../package.json').version;
    const next = current.replace(/\d+$/, (n) => +n + 1);
    const exe = crypto.randomBytes(300 * 1024);
    const sha512 = crypto.createHash('sha512').update(exe).digest('base64');
    const name = `Endpaper-Setup-${next}.exe`;
    const yml = `version: ${next}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${exe.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\nreleaseNotes: 'A stand-in update for the test.'\n`;
    const asked = [];
    let started = 0;
    const server = http.createServer((req, res) => {
      const f = decodeURIComponent(req.url.split('?')[0].slice(1));
      asked.push({ f, t: Date.now() - started });
      if (f === 'latest.yml') return res.writeHead(200, { 'Content-Type': 'text/yaml' }), res.end(yml);
      if (f === name) return res.writeHead(200, { 'Content-Length': exe.length }), res.end(exe);
      res.writeHead(404), res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const userData = H.tempUserData('update');
    started = Date.now();
    const run = await H.launch(__filename, { userData, env: { ENDPAPER_UPDATE_URL: `http://127.0.0.1:${server.address().port}/`, ENDPAPER_UPDATE_DRY: '1', ENDPAPER_NEXT: next } });
    server.close();
    const first = asked.find((a) => a.f === 'latest.yml');
    // Starting takes a second or two; the old 8-second wait would land well after this.
    check('it checks for an update as soon as it opens', !!first && first.t < 6000, first ? `${first.t} ms after starting` : 'never asked');
    check('the installer is only downloaded after Update now', asked.some((a) => a.f === name));
    H.finish('update-check', [run], tally);
  })();
} else {
  module.exports = async ({ win, exec }) => {
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    const { app } = require('electron');
    await appReady();
    const next = process.env.ENDPAPER_NEXT;
    const doc = path.join(app.getPath('userData'), 'update-check.endpaper');

    // A saved design, then an unsaved change.
    await exec(`(async () => {
      await App.newDocument({ name: 'Update check', w: 148, h: 210, pages: 2, kind: 'print', bleed: 3 });
      const d = App.S.doc; const t = Model.newItem('text', 15, 20, 100, 20, d); t.text = 'Before'; d.pages[0].items.push(t);
      App.S.filePath = ${JSON.stringify(doc)}; await App.save();
      App.change('Type', () => { t.text = 'After'; });
      ep.on('update-dry', (f) => { window.__dry = f; });
    })()`);
    check('the update is offered', await waitFor(() => exec(`Updates.state.status === 'available'`), 15000), await exec(`JSON.stringify(Updates.state)`));
    const banner = await exec(`document.getElementById('update-banner').innerText`);
    check(`the banner says "Update available: Endpaper ${next}"`, banner.includes(`Update available: Endpaper ${next}`), banner);
    check('...with Update now, Later and All release notes', ['Update now', 'Later', 'All release notes'].every((b) => banner.includes(b)));
    check('...and says the design will be saved first', /asked to save/.test(banner));

    await exec(`document.querySelector('[data-ub="now"]').click()`);
    check('Update now downloads it', await waitFor(() => exec(`['downloading', 'saving', 'waiting'].includes(Updates.state.status) || !!document.querySelector('.modal [data-a="yes"]')`), 5000));
    check('then asks to save the design first', await waitFor(() => exec(`!!document.querySelector('.modal [data-a="yes"]') && /before updating/.test(document.querySelector('.modal').innerText)`), 30000));
    await exec(`document.querySelector('.modal [data-a="no"]').click()`);
    check('"Not now" waits, without installing', await waitFor(() => exec(`Updates.state.status === 'waiting'`), 5000));
    check('...and the design is still unsaved', await exec(`App.S.dirty`));
    await exec(`document.querySelector('[data-ub="install"]').click()`);
    await waitFor(() => exec(`!!document.querySelector('.modal [data-a="yes"]')`), 5000);
    await exec(`document.querySelector('.modal [data-a="yes"]').click()`);
    check('"Save and update" stops just before installing', await waitFor(() => exec(`!!window.__dry`), 10000));
    await wait(200);
    check('...with the design saved', JSON.parse(fs.readFileSync(doc, 'utf8')).pages[0].items[0].text === 'After');
    const settings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    check('...and remembered, to open again after the update', (settings.reopen || []).some((r) => r.path === doc));
  };
}
