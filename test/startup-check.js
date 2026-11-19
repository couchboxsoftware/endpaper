// Startup: the splash shows on its own, steps through the loading (the four CMYK patches), stays
// at least 2.3 seconds, and hands over to the main window; only one copy of Endpaper runs (a
// second one passes over to the first and quits); F11 switches full screen on and off; and
// Ctrl+, opens Settings.
// Run: node test/startup-check.js
const path = require('path');
const { spawn } = require('child_process');
const H = require('./helper');

if (require.main === module) {
  (async () => {
    const userData = H.tempUserData('startup');
    const run = await H.launch(__filename, { userData, env: { ENDPAPER_TEST_SPLASH: '1' } });
    H.finish('startup-check', [run]);
  })();
} else {
  module.exports = async ({ win, exec, splash }) => {
    const { app } = require('electron');
    const { check, waitFor, appReady, wait } = H.inApp({ exec });
    const t0 = Date.now();

    // The splash: up first, on its own, with the main window still hidden.
    const s = splash();
    check('the splash is showing', !!s && !s.isDestroyed() && (await waitFor(() => s.isVisible(), 3000)));
    check('the main window waits behind it', !win.isVisible());
    let patches = 0;
    let shownMs = 0;
    while (splash() && !splash().isDestroyed()) {
      try {
        patches = Math.max(patches, await splash().webContents.executeJavaScript(`document.querySelectorAll('.patch.on').length`));
      } catch (_) {}
      if (!win.isVisible()) shownMs = Date.now() - t0;
      await wait(100);
      if (Date.now() - t0 > 20000) break;
    }
    check('the splash steps through the loading (four CMYK patches)', patches === 4, `${patches} lit`);
    check('the splash stays at least 2.3 seconds', shownMs >= 2300, `${shownMs} ms`);
    check('the splash hands over and closes', !splash() || splash().isDestroyed());
    check('then the main window shows', await waitFor(() => win.isVisible(), 3000));
    await appReady();

    // Only one copy: a second Endpaper with the same settings passes over to this one and quits.
    let handed = false;
    app.once('second-instance', () => (handed = true));
    const env = { ...process.env };
    delete env.ENDPAPER_TEST;
    delete env.ENDPAPER_TEST_SPLASH;
    const second = spawn(process.execPath, [path.join(__dirname, '..')], { env, windowsHide: true });
    const quit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000);
      second.on('exit', () => (clearTimeout(timer), resolve(true)));
    });
    if (!quit) second.kill();
    check('a second copy quits straight away', quit);
    check('...and brings this one forward', await waitFor(() => handed, 3000));

    // F11, twice.
    win.focus();
    win.webContents.focus();
    const key = (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    key('F11');
    check('F11 goes full screen', await waitFor(() => win.isFullScreen(), 4000));
    key('F11');
    check('F11 again comes out of full screen', await waitFor(() => !win.isFullScreen(), 4000));

    // Ctrl+, opens Settings.
    key(',', ['control']);
    check('Ctrl+, opens Settings', await waitFor(() => exec(`!!document.querySelector('.modal.settings')`), 3000));
  };
}
