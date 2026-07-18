# Vendored libraries

The UI is zero-CDN: everything it runs is served from this repo. Each file below is an
unmodified upstream build, fetched with `npm pack <name>@<version>` and copied out of the
tarball. To update: repack, copy, and bump the line here.

- marked.umd.js — marked v18.0.6 (MIT) — https://github.com/markedjs/marked — `npm pack marked@18.0.6` → `package/lib/marked.umd.js` (v16+ no longer ships a minified build; the UMD is 43 KB)
- purify.min.js — DOMPurify v3.4.12 (Apache-2.0 OR MPL-2.0) — https://github.com/cure53/DOMPurify — `npm pack dompurify@3.4.12` → `package/dist/purify.min.js`
- highlight.min.js — highlight.js v11.11.1, common-languages build (BSD-3-Clause) — https://github.com/highlightjs/highlight.js — `npm pack @highlightjs/cdn-assets@11.11.1` → `package/highlight.min.js`
- mermaid.min.js — mermaid v11.16.0 (MIT) — https://github.com/mermaid-js/mermaid — `npm pack mermaid@11.16.0` → `package/dist/mermaid.min.js`

marked + purify load as classic scripts in index.html (globals — they are needed by every
markdown surface). highlight and mermaid are lazy-loaded by `ui/js/md.js` only when rendered
content actually contains a fenced code block / a ```mermaid fence.
