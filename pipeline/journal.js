'use strict';
// journal — what has ever happened, as opposed to where we are now.
//
// state.json answers "where am I" and is overwritten on every move. This
// answers "what has happened, ever", and is never overwritten: one JSON object
// per line, appended, workspace-wide, across every run of every card. A second
// run of the same card used to write over the first one's prompts and verdicts,
// which meant there was nothing to compare a run against — not even itself.
//
// It exists to be READ BACK. The point is not an audit trail nobody opens; it
// is a corpus you can ask questions of — how often does round one get rejected,
// what do validators keep catching, which cards go the distance. A pipeline you
// cannot measure is a pipeline you can only have opinions about.
//
// So the verdicts go in whole. A findings text truncated to a summary is
// exactly the part you would want a month later.

const fs = require('node:fs');
const path = require('node:path');

// Big enough for a real validator's findings and a real stage prompt; small
// enough that one runaway `run` cannot make the file unreadable.
const MAX_FIELD = 64 * 1024;

function journalFile(workspace) {
  return path.join(workspace, '.bridge-commander', 'pipeline_runs', 'runs.jsonl');
}

function clip(v) {
  if (typeof v !== 'string' || v.length <= MAX_FIELD) return v;
  return v.slice(0, MAX_FIELD) + `\n…[${v.length - MAX_FIELD} more characters]`;
}

// A run id stable across a resume. The command harness re-runs the executor
// from the top when its session is resumed, and those lines are the same run —
// state.startedAt is written once, on the first start, and survives the resume.
function runId(cardId, startedAt) {
  return String(cardId) + '@' + String(startedAt || '').replace(/[:.]/g, '-');
}

// append never throws into the run path, and never blocks it. A journal that
// can abort a pipeline is worse than no journal at all.
function append(workspace, record) {
  try {
    const f = journalFile(workspace);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const line = {};
    for (const [k, v] of Object.entries(record)) line[k] = clip(v);
    fs.appendFileSync(f, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, line)) + '\n');
  } catch (e) {
    process.stderr.write('journal: could not append — ' + String((e && e.message) || e) + '\n');
  }
}

// read(workspace) -> every record, oldest first. A malformed line is skipped
// rather than fatal: this file is append-only and may be being written to right
// now, so the last line can legitimately be half a record.
function read(workspace) {
  let text = '';
  try { text = fs.readFileSync(journalFile(workspace), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn or hand-edited line */ }
  }
  return out;
}

// runs(workspace) -> one folded row per run, oldest first. This is the shape
// every question about the past is actually asked in.
//
// Durations are DERIVED from the timestamps rather than recorded as their own
// field, so lines written before anyone thought to time anything still answer
// the question. A stage lasts from the moment its agent was opened to the
// moment its verdict landed — the wait, which is the whole cost.
function runs(workspace) {
  const byRun = new Map();
  const openedAt = new Map(); // run|stage|round -> ts of stage-open
  for (const r of read(workspace)) {
    if (!r.run) continue;
    let row = byRun.get(r.run);
    if (!row) {
      row = {
        run: r.run, card: r.card, pipeline: r.pipeline, project: r.project,
        started: r.ts, ended: null, base: null, rounds: 0,
        outcome: null, outcomeKind: null, rejections: [], events: 0, restarts: 0,
        ms: null, stages: [],
      };
      byRun.set(r.run, row);
    }
    row.events++;
    if (typeof r.round === 'number' && r.round > row.rounds) row.rounds = r.round;
    if (r.kind === 'start') {
      row.base = r.base || row.base;
      if (r.resumed) row.restarts++;
    }
    const key = r.run + '|' + r.stage + '|' + r.round;
    if (r.kind === 'stage-open') openedAt.set(key, r.ts);
    if (r.kind === 'verdict') {
      const from = openedAt.get(key);
      row.stages.push({
        stage: r.stage, round: r.round, verdict: r.verdict,
        ms: from ? Date.parse(r.ts) - Date.parse(from) : null,
        transcript: r.transcript || null, transcriptBytes: r.transcriptBytes || 0,
      });
      if (r.verdict === 'reject') row.rejections.push({ round: r.round, text: r.text || '' });
    }
    if (r.kind === 'finish' || r.kind === 'escalate' || r.kind === 'refused') {
      row.ended = r.ts;
      row.outcomeKind = r.kind;
      row.outcome = r.outcome || r.text || '';
      row.ms = Date.parse(r.ts) - Date.parse(row.started);
    }
  }
  return [...byRun.values()];
}

// A duration a person reads at a glance. Anything under a minute is seconds;
// past that, nobody cares about the seconds.
function human(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0');
}

// A Journal bound to one run, so the executor writes `j.event('verdict', {…})`
// and never repeats the run's identity.
class Journal {
  constructor(workspace, ids) {
    this.workspace = workspace;
    this.ids = ids; // { run, card, pipeline, project }
  }
  event(kind, fields = {}) {
    append(this.workspace, Object.assign({ kind }, this.ids, fields));
  }
}

module.exports = { Journal, append, read, runs, runId, journalFile, human, MAX_FIELD };
