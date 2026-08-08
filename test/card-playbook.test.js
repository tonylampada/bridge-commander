'use strict';
// The card's playbook: a POINTER to a markdown file the user owns, resolved
// and rendered into the worker's brief at card.start and only there. What this
// pins is the seam — which playbook a card gets, when it is read, and what
// happens when a card has none.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');
const { lieutenantSession, workerWindow } = require('../server/names.js');

function workerKey(dir, cardId) {
  return lieutenantSession(dir, LT) + ':' + workerWindow(cardId);
}
function makeRepo(root) {
  const repo = path.join(root, 'srcrepo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  return repo;
}
async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cardplaybook-'));
  const repo = makeRepo(root);
  const fdir = path.join(root, 'fake');
  const s = await startServerWithLieutenant({
    env: { BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git',
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0' },
  });
  assert.strictEqual((await s.api('POST', '/api/projects', { source: repo, name: 'proj' })).status, 200);
  const teardown = async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); };
  // the prompt the fake harness was spawned with
  const prompt = (cardId) =>
    JSON.parse(fs.readFileSync(path.join(fdir, workerKey(s.dir, cardId) + '.json'), 'utf8')).prompt;
  const pbDir = path.join(s.dir, '.bridge-commander', 'playbooks');
  return { s, fdir, prompt, pbDir, teardown };
}

test('the playbook list is served off disk, workspace and packaged together', async () => {
  const { s, pbDir, teardown } = await boot();
  try {
    let r = await s.api('GET', '/api/playbooks');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.playbooks, ['default', 'investigation', 'no-mistakes']);
    assert.strictEqual(r.body.dir, pbDir);

    // a playbook dropped in a second ago is pickable now — no restart, no cache
    fs.mkdirSync(pbDir, { recursive: true });
    fs.writeFileSync(path.join(pbDir, 'house-style.md'), '# {{CARD_TITLE}}\n');
    r = await s.api('GET', '/api/playbooks');
    assert.ok(r.body.playbooks.includes('house-style'));

    const cli = await runCli(['playbook', 'list', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /^house-style$/m);
    assert.match(cli.stdout, /^no-mistakes$/m);
  } finally { await teardown(); }
});

test('a card carries the playbook it was created with, and card patch --playbook changes it', async () => {
  const { s, teardown } = await boot();
  try {
    const c = await s.api('POST', '/api/cards', withOwner({ title: 'Pick one', playbook: 'no-mistakes' }));
    assert.strictEqual(c.body.card.playbook, 'no-mistakes');

    const cli = await runCli(['card', 'patch', 'pick-one', '--playbook', 'investigation',
      '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.strictEqual((await s.api('GET', '/api/cards/pick-one')).body.playbook, 'investigation');

    // a typo is refused where it is typed, and the error names what exists
    let r = await s.api('PATCH', '/api/cards/pick-one', { playbook: 'no-mistkaes' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unknown playbook: no-mistkaes/);
    assert.match(r.body.error, /no-mistakes/);
    r = await s.api('POST', '/api/cards', withOwner({ title: 'Typo', playbook: 'nope' }));
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unknown playbook: nope/);

    // and it can be cleared back to none
    assert.strictEqual((await s.api('PATCH', '/api/cards/pick-one', { playbook: '' })).status, 200);
    assert.strictEqual((await s.api('GET', '/api/cards/pick-one')).body.playbook, '');
  } finally { await teardown(); }
});

test('card start refuses a card with no playbook, and names the playbooks', async () => {
  const { s, teardown } = await boot();
  try {
    // cards that predate playbooks have none — that is the state, not a bug
    await s.api('POST', '/api/cards', withOwner({ title: 'Old card', playbook: '', attributes: { repo: 'proj' } }));
    const r = await s.api('POST', '/api/cards/old-card/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /has no playbook/);
    assert.match(r.body.error, /card patch old-card --playbook/);
    assert.match(r.body.error, /default, investigation, no-mistakes/);
    // it did not half-start: no worker, still in backlog
    assert.strictEqual((await s.api('GET', '/api/cards/old-card')).body.column, 'backlog');

    // one playbook away from starting
    assert.strictEqual((await s.api('PATCH', '/api/cards/old-card', { playbook: 'default' })).status, 200);
    assert.strictEqual((await s.api('POST', '/api/cards/old-card/start', { harness: 'fake' })).status, 200);
  } finally { await teardown(); }
});

// The dead `brief` key is not migrated and not special-cased: it is simply not
// a key the board reads, so a card carrying only that one has no playbook and
// takes the refusal every playbookless card already takes.
test('a card whose only key is the dead `brief` has no playbook, and no special case says so', async () => {
  const { s, teardown } = await boot();
  try {
    const c = await s.api('POST', '/api/cards', withOwner({
      title: 'Legacy', playbook: '', brief: 'default', attributes: { repo: 'proj' },
    }));
    assert.strictEqual(c.body.card.playbook, '');
    assert.strictEqual(c.body.card.brief, undefined, '`brief` is not a card key');
    const r = await s.api('POST', '/api/cards/legacy/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /has no playbook/);
  } finally { await teardown(); }
});

test('the card gets ITS playbook: playbook no-mistakes renders no-mistakes.md, fully', async () => {
  const { s, prompt, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Gate it', playbook: 'no-mistakes', attributes: { repo: 'proj' }, body: 'add the flag',
    }));
    assert.strictEqual((await s.api('POST', '/api/cards/gate-it/start', { harness: 'fake' })).status, 200);
    const p = prompt('gate-it');
    assert.match(p, /^# Gate it \(gate-it\)/);
    assert.match(p, /Delivery — the no-mistakes gate/);
    assert.match(p, /add the flag/);
    assert.doesNotMatch(p, /\{\{/, 'nothing left unrendered');
    // the OTHER playbooks' text is nowhere near it
    assert.doesNotMatch(p, /a report, not a change/);
  } finally { await teardown(); }
});

test('the playbook resolves at START: the body edited a second before it is the body the worker reads', async () => {
  const { s, prompt, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Stale?', playbook: 'default', attributes: { repo: 'proj' }, body: 'the ORIGINAL plan',
    }));
    // everything the brief reads keeps moving between create and start
    await s.api('PATCH', '/api/cards/stale', { title: 'Fresh!', body: 'the REWRITTEN plan' });
    await s.api('POST', '/api/feedback', { target: 'card:stale', text: 'and mind the mobile flow' });
    assert.strictEqual((await s.api('POST', '/api/cards/stale/start', { harness: 'fake' })).status, 200);

    const p = prompt('stale');
    assert.match(p, /the REWRITTEN plan/);
    assert.match(p, /^# Fresh! \(stale\)/);
    assert.match(p, /and mind the mobile flow/);
    assert.doesNotMatch(p, /the ORIGINAL plan/);
  } finally { await teardown(); }
});

test('editing playbooks/default.md changes the next card started on it — no restart', async () => {
  const { s, prompt, pbDir, teardown } = await boot();
  try {
    fs.mkdirSync(pbDir, { recursive: true });
    fs.writeFileSync(path.join(pbDir, 'default.md'), 'HOUSE STYLE for {{CARD_ID}}\n');
    await s.api('POST', '/api/cards', withOwner({ title: 'After the edit', attributes: { repo: 'proj' } }));
    assert.strictEqual((await s.api('POST', '/api/cards/after-the-edit/start', { harness: 'fake' })).status, 200);
    assert.strictEqual(prompt('after-the-edit'), 'HOUSE STYLE for after-the-edit\n');

    // edit it again — the NEXT card gets the new text, same running server
    fs.writeFileSync(path.join(pbDir, 'default.md'), 'SECOND take for {{CARD_ID}}\n');
    await s.api('POST', '/api/cards', withOwner({ title: 'After the second', attributes: { repo: 'proj' } }));
    assert.strictEqual((await s.api('POST', '/api/cards/after-the-second/start', { harness: 'fake' })).status, 200);
    assert.strictEqual(prompt('after-the-second'), 'SECOND take for after-the-second\n');
  } finally { await teardown(); }
});

test('{{ATTR_*}} reads the card attributes at start; one that does not exist stays literal', async () => {
  const { s, prompt, pbDir, teardown } = await boot();
  try {
    fs.mkdirSync(pbDir, { recursive: true });
    fs.writeFileSync(path.join(pbDir, 'attrs.md'),
      'PR {{ATTR_PR_URL}} on {{ATTR_REPO}} — {{ATTR_MISSING}}\n');
    await s.api('POST', '/api/cards', withOwner({ title: 'Review it', playbook: 'attrs', attributes: { repo: 'proj' } }));
    // set through the CLI, exactly as a lieutenant would
    const cli = await runCli(['card', 'patch', 'review-it', '--attr', 'pr_url=https://github.com/o/r/pull/9',
      '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.strictEqual((await s.api('POST', '/api/cards/review-it/start', { harness: 'fake' })).status, 200);
    assert.strictEqual(prompt('review-it'),
      'PR https://github.com/o/r/pull/9 on proj — {{ATTR_MISSING}}\n');
  } finally { await teardown(); }
});

test('a playbook deleted out from under the card is a loud refusal', async () => {
  const { s, pbDir, teardown } = await boot();
  try {
    fs.mkdirSync(pbDir, { recursive: true });
    fs.writeFileSync(path.join(pbDir, 'doomed.md'), 'hi {{CARD_ID}}\n');
    await s.api('POST', '/api/cards', withOwner({ title: 'Orphan', playbook: 'doomed', attributes: { repo: 'proj' } }));
    fs.unlinkSync(path.join(pbDir, 'doomed.md'));
    const r = await s.api('POST', '/api/cards/orphan/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /points at playbook "doomed", which no file matches/);
  } finally { await teardown(); }
});
