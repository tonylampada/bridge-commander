# Event pipeline — worker brief (fixture artifact)

You are implementing phase 0 (shadow writes) of the unified event pipeline.

## Contract

- Append a Record for every existing write path; legacy fields stay canonical.
- One new module `server/pipeline.js`, node built-ins only.
- `node --test test/*.test.js` stays green; add `test/pipeline.test.js`.

## Notes

- The log lives at `.bridge-commander/pipeline.jsonl`.
- Torn-tail policy: truncate the last line if it fails `JSON.parse`.
- Do NOT touch the SSE payload in this phase.
