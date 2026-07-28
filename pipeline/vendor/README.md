# Vendored, same house rule as `ui/vendor/`

The repo has no dependencies and no install step. Reading YAML is the one thing worth
not writing by hand — a pipeline file is edited by humans, and a homemade parser would
disagree with their editor about what is legal YAML, which is a worse bug than any it
would save. So the parser is fetched, committed, and read from here. No CDN, no
`npm install`, no `package.json`.

Each file is an unmodified upstream build, fetched with `npm pack <name>@<version>` and
copied out of the tarball. To update: repack, copy, bump the line here.

- `js-yaml.min.js` — js-yaml v4.1.0 (MIT) — https://github.com/nodeca/js-yaml —
  `npm pack js-yaml@4.1.0` → `package/dist/js-yaml.min.js`. The UMD build; `require()`
  works on it directly. Its exceptions carry `mark.line`, which is how a broken pipeline
  file gets refused with a line number instead of a stack trace.
- `js-yaml.LICENSE` — its MIT license, verbatim.
