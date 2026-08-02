# Vendored libraries

The UI is zero-CDN: everything it runs is served from this repo. Each file below is an
unmodified upstream build, fetched with `npm pack <name>@<version>` and copied out of the
tarball. To update: repack, copy, and bump the line here.

- marked.umd.js — marked v18.0.6 (MIT) — https://github.com/markedjs/marked — `npm pack marked@18.0.6` → `package/lib/marked.umd.js` (v16+ no longer ships a minified build; the UMD is 43 KB)
- purify.min.js — DOMPurify v3.4.12 (Apache-2.0 OR MPL-2.0) — https://github.com/cure53/DOMPurify — `npm pack dompurify@3.4.12` → `package/dist/purify.min.js`
- highlight.min.js — highlight.js v11.11.1, common-languages build (BSD-3-Clause) — https://github.com/highlightjs/highlight.js — `npm pack @highlightjs/cdn-assets@11.11.1` → `package/highlight.min.js`
- mermaid.min.js — mermaid v11.16.0 (MIT) — https://github.com/mermaid-js/mermaid — `npm pack mermaid@11.16.0` → `package/dist/mermaid.min.js`
- codemirror/ — CodeMirror v5.65.21 (MIT) — https://github.com/codemirror/codemirror5 — `npm pack codemirror@5.65.21` → `package/{lib/codemirror.js,lib/codemirror.css,mode/meta.js,addon/mode/loadmode.js,mode/<lang>/<lang>.js}`. CodeMirror 5, not 6: 5 is a single UMD file plus one file per language, which is what a board with no build step can serve. No theme file is vendored — the board's own palette is the `cm-s-bc` theme in app.css. Languages present: clike, css, diff, dockerfile, go, htmlmixed, javascript, jsx, lua, markdown, perl, php, properties, python, ruby, rust, shell, sql, toml, xml, yaml — drop another `mode/<lang>/<lang>.js` in to add one.

- react.production.min.js, react-dom.production.min.js — React 18.3.1 (MIT) — https://github.com/facebook/react — `npm pack react@18.3.1 react-dom@18.3.1` → `package/umd/{react,react-dom}.production.min.js`. React 18, not 19: 19 dropped the UMD builds, and a UMD that sets `window.React` is the only form a no-build-step page can load. Only here because Excalidraw needs it.
- excalidraw/ — Excalidraw v0.17.6 (MIT) — https://github.com/excalidraw/excalidraw — `npm pack @excalidraw/excalidraw@0.17.6` → `package/dist/{excalidraw.production.min.js,excalidraw-assets/}`. 0.17, not 0.18: 0.18 ships ESM with ~28 bare-specifier imports (react, jotai, roughjs, …) and can only be loaded through a bundler. 0.17 is the last UMD release — it takes `window.React`/`window.ReactDOM` and hands back `window.ExcalidrawLib`. `excalidraw-assets/` holds the woff2 fonts plus the lazy `vendor-*.js` chunk the bundle fetches on mount; `window.EXCALIDRAW_ASSET_PATH` must point at that directory before the bundle initialises. The 60-odd `locales/` files are deliberately NOT vendored — English is baked into the main bundle.

- iwer/iwer.module.min.js — IWER, the Immersive Web Emulation Runtime, v2.3.0 (MIT) — https://github.com/meta-quest/immersive-web-emulation-runtime — `npm pack iwer@2.3.0` → `package/build/iwer.module.min.js` (190 KB). Meta's own runtime: it installs a synthetic `navigator.xr`, so a genuine `immersive-vr` session runs in a desktop browser with scriptable head and controller poses. The `build/` bundle is what is vendored, not `lib/` — the module build is rollup'd with its two dependencies (gl-matrix, webxr-layers-polyfill) inlined, so it has no bare specifiers and needs no import map. `@iwer/devui`, the interactive emulator panel, is deliberately NOT vendored: 850 KB for controls `ui/js/bridge3d/devxr.js` gives with a mouse in twenty lines. Loaded by that file alone, dynamically, only when `?xr=emulate` is on the URL — see `ui/js/bridge3d/README.md`.

- three/three.module.min.js — three.js r169 (MIT) — https://github.com/mrdoob/three.js — `npm pack three@0.169.0` → `package/build/three.module.min.js` (672 KB raw, 166 KB gzipped). Only the core build: the `examples/jsm` addons — the WebXR button, the controller models, the orbit camera — all import the bare specifier `three`, which needs an import map or a bundler, so the few lines of them this page wanted are hand-written in `ui/js/bridge3d/` instead. Nothing the board ships imports it.

marked + purify load as classic scripts in index.html (globals — they are needed by every
markdown surface). highlight and mermaid are lazy-loaded by `ui/js/md.js` only when rendered
content actually contains a fenced code block / a ```mermaid fence. CodeMirror is lazy-loaded
the same way by `ui/js/fileedit.js`, on the first file editor opened — and its language modes
one at a time after that.

React + Excalidraw are lazy-loaded by `ui/js/draw.js` alone, on the first `.excalidraw`
artifact opened — the only file in `ui/js/` that knows React exists. Nothing else imports
them, and a board that never opens a drawing never fetches them.

three.js is a bet the board has not taken yet: only `ui/bridge3d.html` loads it, and that page
is a prototype of the board inside a headset — four spatial arrangements, live panes on
surfaces, meant to have three of its four ideas killed by an evening of wearing it. If the room
turns out not to be worth building, delete `three/`, `three.LICENSE`, `iwer/`, `iwer.LICENSE`,
`ui/bridge3d.html`, `ui/js/bridge3d/`, `dev/room-shots.js` and `test/bridge3d.test.js`; nothing
else references any of it.
