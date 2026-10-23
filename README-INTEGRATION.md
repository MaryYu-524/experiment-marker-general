# Experiment Marker General — Welcome v6 integration

This package is based on the most recent confirmed `v0.6b READY empty` source files plus the accepted Welcome v6 animation. Only General is affected.

## Install locally
1. Ensure your VS Code folder and terminal both point to `experiment-marker-general`, not Personal.
2. Make a backup/commit of current General work before covering files.
3. Copy `app.js`, `index.html`, `style.css`, and **new** `welcome.html` from this package into the General repository root. Keep `storage.js`, `manifest.json`, and existing `service-worker.js` untouched.
4. Run `node --check app.js` and `python3 -m http.server 8081` (or Live Server).
5. On a fresh origin (without existing cases/custom presets), opening General shows Welcome once. Tap Get Started, then reload — it should go straight to READY.
6. For **preview only** even on an existing test installation, open `http://localhost:8081/?welcome=preview` (READY only). This does not alter existing records or the Welcome-seen setting.
7. With a RUNNING or COMPLETE current case, reload and verify the app resumes its existing view directly, never forcing Welcome in front.

## Release/offline caching (important)
Because the existing `service-worker.js` was not included in the uploaded source set, this package deliberately does NOT overwrite it. Before GitHub Pages deployment:
- Add `"./welcome.html",` to `APP_SHELL` in General `service-worker.js` alongside `"./index.html",`.
- Bump the General-specific `CACHE_NAME` to a new unique release value, e.g. `experiment-marker-general-v06b-welcome1`.
- Confirm the app scope/path is General and not Personal; test a first install online, then reload offline.
Without this edit, offline first-use Welcome is not guaranteed.

## Design / behavior
- SVG and welcome page visual styles are isolated inside `welcome.html` via an iframe. Its original motion paths and timing remain unchanged.
- General initializes from persistent storage before deciding to show Welcome; RUNNING / COMPLETE are always preferred.
- Existing cases, archives or custom presets imply previous usage and automatically skip the first-time introduction.
- `?welcome=preview` allows manual design review on READY without marking Welcome as seen.
- The first-run flag is `experiment-marker-general-welcome-v1-seen` in localStorage. Clearing it without changing any case records is one way to re-test first launch; use the URL preview mode instead if possible.
- In embedded mode, experimental Replay and prototype-only note are hidden, but the standalone `welcome.html` still supports them.
- When Welcome is dismissed, keyboard focus moves to the READY section, not the Case ID textbox, so mobile keyboards do not pop up automatically.

## Check versions
`git diff -- app.js index.html style.css` and `git status`. Never publish until local smoke testing is complete.
