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
- three/MathUtils.js — the same three.js r169 tarball, `package/src/math/MathUtils.js`, unmodified. uikit imports `three/src/math/MathUtils.js` by that exact deep path in three places, and the minified core build does not answer to it — it is one dependency-free file of pure functions, so the import map points that specifier here rather than at a shim we would have had to write and then maintain.

### The room's stack — pmndrs uikit, vanilla

Loaded only by `ui/bridge3d.html`, through the `<script type="importmap">` in that page.
Pure ESM with an explicit `.js` on every relative import, which is the whole reason it vendors
at all: no React, no bundler, no CDN, no build step. **Reachable from the room: 181 files,
1.43 MB raw, 544 KB gzipped** — and the single biggest piece of that is one font.

The evidence this is the right stack rather than a taste: Meta's own WebXR SDK for Quest
(`facebook/immersive-web-sdk`) is built on `three` + `@pmndrs/uikit` + `@pmndrs/pointer-events`
+ `@pmndrs/handle`. See the `vr-design` skill's `building.md` for the survey and the rivals.

- uikit/ — `@pmndrs/uikit` v1.0.74 (MIT) — https://github.com/pmndrs/uikit — `npm pack @pmndrs/uikit@1.0.74` → `package/dist/**/*.js` (the `.d.ts` and `.map` files are not copied; nothing serves them). Yoga flexbox layout with CSS-like properties, MSDF text that stays sharp at any distance, instanced panels, scroll, and `hover`/`active`/`focus` conditional properties. **Import components ONE AT A TIME** — `uikit/components/container.js`, never `uikit/index.js` or `uikit/components/index.js`: the barrel reaches for `components/svg.js`, which imports the three.js addon `SVGLoader` that this repo does not vendor, and in the finished kits it also drags in an icon set of 1,595 modules. A test in `test/bridge3d.test.js` fails if anything imports a barrel. The LICENSE is not in the tarball; it is fetched from the repo root.
- uikit-pub-sub/ — `@pmndrs/uikit-pub-sub` v1.0.74 (MIT) — uikit's own tiny event bus. One file, pulled in by uikit.
- pointer-events/ — `@pmndrs/pointer-events` v6.6.30 (MIT) — https://github.com/pmndrs/xr — `npm pack` → `package/dist/**/*.js`. Zero dependencies. Ray, grab and touch pointers with W3C-shaped events on real three.js objects; this is what replaced the room declaring rectangles while it painted. One trap worth knowing: it reads `object.pointerEvents`, and uikit **rewrites that field out of its own properties on every effect pass** — so a uikit component is made inert with `setProperties({ pointerEvents: 'none' })` and never by assignment.
- msdfonts/inter.js — `@pmndrs/msdfonts` v1.0.74 (MIT) — `npm pack` → `package/dist/inter.js` only. Four weights of Inter as base64 WebP atlases plus metrics, 444 KB raw and 277 KB gzipped — **over half the weight of the whole stack**, and it does not compress because it is already WebP. The other seventeen fonts in the tarball are deliberately not vendored. uikit reaches for `@pmndrs/msdfonts/inter` through a dynamic import when a `Text` first needs a font, which is why the import map carries that exact specifier. The atlas holds **104 glyphs** — ASCII plus a little German, no emoji, no `·`, no `…`, no `×` — so every string the room paints goes through `safe()` in `ui/js/bridge3d/kit.js` first.
- yoga-layout/ — `yoga-layout` v3.2.1 (MIT, Meta) — `npm pack` → `package/dist/{src,binaries}/**/*.js`. The flexbox engine, as an Emscripten build with the WASM base64-inlined into `binaries/yoga-wasm-base64-esm.js`, so it needs no separate asset fetch and no MIME configuration. The import map maps `yoga-layout/load`, which is the only entry point uikit uses. LICENSE fetched from the repo root; the tarball ships only `dist/` and `src/`.
- signals-core/signals-core.js — `@preact/signals-core` v1.14.4 (MIT) — `npm pack` → `package/dist/signals-core.mjs`, **renamed to `.js`**. Content byte-for-byte unmodified; only the extension changed, because a static file server that has never heard of `.mjs` serves it as `application/octet-stream` and a browser refuses a module script with that MIME type. Renaming it is one line here; teaching every server that serves this repo about `.mjs` is not.
- zod/ — `zod` v4.4.3 (MIT) — `npm pack` → `package/index.js` plus `package/v4/{core,classic,locales}/**/*.js`. Not a choice: uikit imports `zod` at runtime from its property and flex schemas. 79 files and 128 KB gzipped, of which the 53 `locales/` files are about 40 KB — they come along because zod's root entry re-exports them, and cutting them would mean modifying an upstream build. It is the least satisfying line in this file and it is the price of the layout engine.

marked + purify load as classic scripts in index.html (globals — they are needed by every
markdown surface). highlight and mermaid are lazy-loaded by `ui/js/md.js` only when rendered
content actually contains a fenced code block / a ```mermaid fence. CodeMirror is lazy-loaded
the same way by `ui/js/fileedit.js`, on the first file editor opened — and its language modes
one at a time after that.

React + Excalidraw are lazy-loaded by `ui/js/draw.js` alone, on the first `.excalidraw`
artifact opened — the only file in `ui/js/` that knows React exists. Nothing else imports
them, and a board that never opens a drawing never fetches them.

three.js and the whole pmndrs stack are a bet the board has not taken yet: only
`ui/bridge3d.html` loads any of it, and that page is the board as a room you stand inside —
four shelves, cards as slabs in slots, the lieutenants as spheres. If the room
turns out not to be worth building, delete `three/`, `three.LICENSE`, `iwer/`, `iwer.LICENSE`,
`uikit/`, `uikit-pub-sub/`, `pointer-events/`, `msdfonts/`, `yoga-layout/`, `signals-core/`,
`zod/` and their `.LICENSE` files,
`ui/bridge3d.html`, `ui/js/bridge3d/`, `dev/room-shots.js` and `test/bridge3d.test.js`; nothing
else references any of it.
