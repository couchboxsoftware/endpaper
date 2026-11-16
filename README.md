# Endpaper

Print-ready designs and books, in CMYK. A Windows desktop app (Electron), built the same way as Couchbox.

Start it with **Start Endpaper.cmd**, or `npm start`.

## What's where

- `main.js`: the window, files, fonts, colour profiles, settings, brand kit, templates and bin, recovery.
- `renderer/model.js`: the document: pages, masters, cover, swatches, styles. Everything is in mm.
- `renderer/fonts.js`: fonts and text layout (wrapping, justification, threads), shared by screen and PDF.
- `renderer/color.js`: LittleCMS colour management with the printing profile (Coated FOGRA39 by default).
- `renderer/editor.js`: the canvas: drag, resize, rotate, snapping, text editing, photo cropping.
- `renderer/panels.js`: Pages, Layers, Properties, Colours, Brand kit, Check.
- `renderer/pdf.js` + `renderer/cmyk-jpeg.js`: PDF/X-4 export with CMYK photos, bleed and crop marks.
- `renderer/preflight.js`: the print checks.
- `renderer/brand.js`: the Endpaper logo and colours. `tools/render-icon.js` makes `build/icon.png`.
- `CHANGELOG.md`: shown in What's new, the update banner and the GitHub release notes. Same writing rules as Couchbox.
- `src/main/updater.js` + `renderer/updates.js`: updates from GitHub Releases.
- `tools/release.js`: builds the installer and publishes a release.

## Updates

The installed app checks GitHub Releases (couchboxsoftware/endpaper) when it starts and every 6 hours. It can also check from Settings, App, Check for updates. When there's a new version, a banner shows the release notes and an Update now button.

- Nothing downloads until you click Update now.
- Nothing installs while the open design has unsaved changes. Endpaper asks you to save it first. If you say Not now, the update waits until you click Save and update.
- After the update, Endpaper opens the design again on the page you were on.

## Releasing a new version

1. Add an entry at the top of `CHANGELOG.md`, like `## 0.1.1 · 20 Nov 2026`.
2. Commit your changes.
3. Run `npm run release -- 0.1.1`.

This sets the version, builds `dist/Endpaper-Setup-0.1.1.exe`, tags `v0.1.1`, pushes, and creates the GitHub release. The release carries the installer, the blockmap and `latest.yml`, and uses the changelog entry as its notes. It needs Git and the GitHub CLI, signed in once with `gh auth login`. `npm run release -- 0.1.1 --dry-run` builds the release without publishing anything.

To build the installer only, run `npm run dist`.

### Testing updates without publishing

Serve a folder that holds a `latest.yml` and the installer at `http://localhost:8787/`. Then start the app with `EP_UPDATE_URL=http://localhost:8787/`. Add `EP_UPDATE_DRY=1` to stop just before it installs.

## Not done yet

- File Explorer right-click. Double-clicking a .endpaper file opens it in the installed app.
- The installer isn't code-signed, so Windows SmartScreen warns the first time it's run. Click More info, then Run anyway.
- Mixed styles inside one paragraph (one bold word), hyphenation, spot (Pantone) colours, grouping, hardback covers.
- Font collections (.ttc files, like Cambria) aren't listed.
- Photos are treated as sRGB.
- The PDF/X-4 files haven't been through a certified preflight (Acrobat or the printer's). Send a test file and get a proof first.
