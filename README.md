# Endpaper

Print-ready designs and books, in CMYK: a Windows desktop app (Electron) from Couchbox Software, built to the Couchbox Software app standard as a **work** app.

## Install

Download `Endpaper-Setup-x.y.z.exe` from the latest release on GitHub (couchboxsoftware/endpaper) and run it. It installs for you only, with a Start menu shortcut, and asks nothing.

The installer isn't code-signed yet, so Windows SmartScreen warns the first time it's run. Click **More info**, then **Run anyway**. Some antivirus programs (Avast, for one) may also need an exception for the installer or for `%LOCALAPPDATA%\Programs\Endpaper`.

To run it from this folder instead, double-click **Start Endpaper.cmd** (or `npm start`). Run this way it's the test version: it shows "Test version" in the title bar and keeps its own settings, so it runs alongside the installed Endpaper.

## Updates

The installed app checks GitHub Releases as soon as it opens, then every 6 hours. It can also check from **File, Settings, Updates and what's new** (Settings, App). When there's a new version, a banner in the bottom-right corner shows its headline with **Update now**, **Later** and **All release notes**.

- Nothing downloads until you click Update now.
- Nothing installs while the open design has unsaved changes. Endpaper asks you to save it first. If you say Not now, the update waits until you click Save and update.
- After the update, Endpaper opens the design again on the page you were on, and a card in the bottom-left corner shows what's new, once.

### Testing updates without publishing

Serve a folder that holds a `latest.yml` and the installer at a localhost address, then start the app with `ENDPAPER_UPDATE_URL=http://localhost:PORT/` (only localhost is accepted). Add `ENDPAPER_UPDATE_DRY=1` to stop just before it installs. `test/update-check.js` does all of this for you.

## Releasing a new version

1. Add an entry at the top of `CHANGELOG.md`, following the template at the top of that file, like `## 0.1.6 · 19 Nov 2026`.
2. Commit your changes.
3. Run `npm run release -- 0.1.6`.

It first fetches the background-removal model if it isn't in `models` yet (see below). Then it checks the changelog entry, that everything's committed, that the GitHub CLI is signed in (`gh auth login`, once) and that the version is new. Then it sets the version, copies the project to `%TEMP%\endpaper-build` and builds the installer there (the installer tool fails on long paths), and brings `Endpaper-Setup-0.1.6.exe`, its `.blockmap` and `latest.yml` back to `dist\`. Last, it commits, tags `v0.1.6`, pushes, and creates the GitHub release with those three files and the changelog entry as its notes.

`npm run release -- 0.1.6 --dry-run` does the checks and the build without committing or publishing anything. To build the installer only, run `npm run dist`.

## What's where

- `main.js`: the window, the splash hand-over, files, fonts, colour profiles, settings, brand kit, templates and bin, recovery, and the test hook (`ENDPAPER_TEST`).
- `preload.js`: the only bridge between the page and the system (`window.ep`).
- `src/main/updater.js`: checking, downloading and installing updates from GitHub Releases.
- `src/main/inkdesktop.js`: finding Inkdesktop (Couchbox Software's PDF app) and opening exported files in it, or in Windows' default app.
- `renderer/index.html` + `renderer/styles.css`: the page and its look (dark only, Endpaper's tokens).
- `renderer/app.js`: state, undo, files, export, Settings, the start screen and the menus.
- `renderer/menubar.js`: the File, Edit, View… menu bar in the title bar (the menus themselves are in `renderer/app.js`).
- `renderer/model.js`: the document: pages, masters (and page copies of master boxes), cover, swatches, styles. Everything is in mm.
- `renderer/fonts.js`: fonts and text layout (wrapping, justification, threads), shared by screen and PDF.
- `renderer/color.js`: LittleCMS colour management with the printing profile (Coated FOGRA39 by default).
- `renderer/editor.js`: the canvas: drag, resize, rotate, snapping, text editing, photo cropping.
- `renderer/panels.js`: Pages, Layers, Properties, Colours, Brand kit, Check.
- `renderer/render.js`: drawing designs for thumbnails and image export.
- `renderer/pdf.js` + `renderer/cmyk-jpeg.js`: PDF/X-4 export with CMYK photos, bleed and crop marks.
- `renderer/preflight.js`: the print checks.
- `renderer/updates.js`: the update banner and the Updates part of Settings, App.
- `renderer/whatsnew.js`: What's new in Settings, App, and the card after an update, with the coloured New, Improved and Fixed titles.
- `renderer/hints.js`: every hint pop-up, in one list (Settings, Hints can show them again).
- `renderer/bookview.js`: Preview book (View, Preview book): the design as a book you can page through and turn over.
- `renderer/shipment.js`: Shipment preparation (File, Shipment preparation): the paper and binding, and the size and weight of a copy. The sums are `Model.bookSpecs` in `renderer/model.js`.
- `renderer/placetext.js`: Place text (Insert, Place text…) and Format story (Type, Format story…), a panel over the right-hand panel. Pasted text appears live in a linked text box inside the margins of each page in a range, with its look (style, font, size, spacing, colour, alignment) set in the same panel; pages are added and taken away to fit until Done, which is one undo step. A line with just `---` moves text that continues on to the next box (`Layout` in `renderer/fonts.js`).
- `renderer/photofx.js`: the photo effects engine (light, colour, detail, shape and blending). It knows nothing about Endpaper, so it can be lifted into another app.
- `renderer/texturegen.js`: the drawn textures for the Texture effect (paper, canvas, linen and the rest), made to repeat seamlessly, and the check for whether any picture repeats. Like `photofx.js`, it knows nothing about Endpaper.
- `renderer/textures.js`: your own textures: the library on this computer (kept in the `textures` folder of Endpaper's settings folder), the copy each design keeps, and the texture picker in Edit photo.
- `renderer/photoedit.js`: photo effects in Endpaper: the Edit photo window (Object, Edit photo), the effects list in Properties, and drawing a frame's effects on the page, in thumbnails and in the PDF. Also Remove background's tools there (Find the subject, the wand and the brush); its masks are kept in the design like photos.
- `renderer/itemfx.js`: effects on groups, text boxes and shapes, and the Effects list for them in Properties. A group's effects go on its merged shape (one shadow, one outline round the outside). Shape effects keep text as text in the PDF; picture effects print it as a picture (600 ppi with text) while it stays editable in Endpaper. The page, thumbnails, PNG and the PDF all use it.
- `src/bgworker.js`: Remove background's helper process. It runs the model (BiRefNet lite, on the graphics card through DirectML, or the processor) for `main.js`, and closes when it's been idle for a while so its memory goes back to Windows.
- `models/`: the background-removal model, `birefnet-lite-fp16.onnx` (114.5 MB). It's too big for git, so `tools/get-model.js` fetches it from a pinned version and checks its fingerprint; `npm run dist` and `npm run release` run that for you. The installer carries it beside the app (`resourcesmodels`).
- `renderer/inkdesktop.js`: what opens after export, and the "Do you want to try Inkdesktop?" window, in Inkdesktop's own colours and pen nib.
- `renderer/util.js`: shared helpers: `$`, `esc`, toasts, windows, menus.
- `renderer/brand.js`: the logo (the open book), the magenta and the wordmark. Everything else reads it.
- `renderer/splash.html` + `renderer/splash.js`: the open-book splash screen.
- `tools/release.js`: builds the installer in a short folder and publishes a release.
- `tools/render-icon.js`: makes `build/icon.png` (512×512) and the icon check sheet `build/icon-preview.png` (not committed) from `renderer/brand.js`. Run `node_modules\electron\dist\electron.exe tools/render-icon.js`.
- `tools/preview-splash.js`: shows the splash without starting the app and saves frames to `build/splash-preview-*.png` (not committed). Run `node_modules\electron\dist\electron.exe tools/preview-splash.js`.
- `test/`: checks that drive the real app (see Tests).
- `CHANGELOG.md`: every version, shown in What's new, the update banner and the GitHub release notes.
- `dev-app-update.yml`: only for testing updates from this folder.
- `Start Endpaper.cmd`: starts the test version with a double-click.
- `LICENSE`: MIT.

## Where data is kept

Everything lives in `%APPDATA%\Endpaper`:

- `settings.json`: settings, recent files, the three remembered folders (where you last saved a design, brought in a picture and exported), turned-off hints (including "Try Inkdesktop"), whether to open files after export, and what to reopen after an update.
- `brandkit.json`: your brand kit (colours, text styles, logos).
- `templates\`: your templates. Deleted ones go to `bin\` and stay there for 30 days.
- `recovery\`: copies of unsaved work, made every 20 seconds and offered back if Endpaper closes unexpectedly.
- `fonts\` and `profiles\`: fonts and printing profiles you've added.

Deleting that folder resets Endpaper. Your designs are `.endpaper` files, wherever you save them. The test version keeps its own copy in `%APPDATA%\Endpaper Test Version`.

## Tests

The checks drive the real app. Each one makes a throwaway settings folder, starts Endpaper with `ENDPAPER_TEST` pointing at the check (and `ENDPAPER_TEST_USERDATA` at that folder), and prints PASS or FAIL for each thing it checks. They never touch your real settings or designs. Run them all with `npm test`, or one with `node test/startup-check.js`.

- `startup-check.js`: the splash shows on its own, lights its four loading patches, stays at least 2.3 seconds and hands over to the main window; only one copy runs (a second one passes over to the first and quits); F11 switches full screen on and off; Ctrl+, opens Settings.
- `update-check.js`: against a stand-in release on a local server, Endpaper checks as soon as it opens; the banner offers the update; Update now downloads it; with unsaved work it asks to save first, Not now waits, Save and update saves, remembers the design to reopen, and stops just before installing.
- `whatsnew-check.js`: every CHANGELOG entry follows the template (and the check catches mistakes); Settings, App shows the newest three versions with "You have this" and New, Improved and Fixed in their colours and order; the card shows once after an update, not a second time, and not on a brand-new install.
- `settings-check.js`: Settings has its five tabs, each holds its own settings, changes are saved straight away and kept after opening again, Settings reopens on the tab used last, and a new install opens maximised.
- `close-check.js`: windows only close on a press and release outside them (dragging out of one keeps it open) and Esc closes the top one; with nothing unsaved Endpaper just closes; with unsaved work it asks first, Cancel keeps it open, and Don't save closes it.

Then one check per feature:

- `export-open-check.js`: with Inkdesktop installed, the Export window offers "Open files in Inkdesktop after export" (ticked to start with, then as last left); a book export opens its inside pages in Inkdesktop and shows the folder; pictures show the folder. Without it: "Open file(s) after export", and "Do you want to try Inkdesktop?" before anything opens, in Inkdesktop's colours; its buttons, "Don't ask again", and Settings, Hints bringing it back. It uses a stand-in Inkdesktop (`ENDPAPER_TEST_INKDESKTOP`) and exports to a throwaway folder (`ENDPAPER_TEST_EXPORT_DIR`), and nothing is really opened.
- `cover-pages-check.js`: with the cover as single pages, a box across the fold shows on the front and back (and inside front and back) thumbnails, and changing it on one page redraws the other's thumbnail too, both ways, and after undo.
- `folders-check.js`: Endpaper remembers where you last saved a design (also where File, Open starts), brought in a picture and exported, each on its own and after opening again; Save as starts beside the open design; a folder that's gone is ignored. Windows' file windows are stood in for, so nothing waits for a click.

`test/helper.js` is what they share, and `test/run-all.js` runs them in turn.

## Not done yet

- File Explorer right-click. Double-clicking a .endpaper file opens it in the installed app.
- The installer isn't code-signed (see Install).
- Mixed styles inside one paragraph (one bold word), hyphenation, spot (Pantone) colours, groups inside groups, hardback covers.
- Font collections (.ttc files, like Cambria) aren't listed.
- Photos are treated as sRGB.
- The PDF/X-4 files haven't been through a certified preflight (Acrobat or the printer's). Send a test file and get a proof first.

## Licence

MIT. Copyright (c) 2026 Couchbox Software. See `LICENSE`.

Remove background uses BiRefNet lite by Peng Zheng et al. (MIT licence, https://github.com/ZhengPeng7/BiRefNet), through its ONNX copy at huggingface.co/onnx-community/BiRefNet_lite-ONNX, run with ONNX Runtime (Microsoft, MIT licence).
