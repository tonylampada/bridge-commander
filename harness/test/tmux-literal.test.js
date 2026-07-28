'use strict';
// sendLiteral / sendKey against REAL tmux — the one guarantee a mock cannot
// give. tmux runs its trailing operand through getopt, which PERMUTES: text
// beginning with '-' is read as FLAGS rather than typed. Unguarded, a pane-input
// payload of `-t=<other-session>:` retargets send-keys at a pane the caller was
// never authorised to touch. A mocked tmux would happily "pass" either way,
// because the bug lives in argv parsing, not in our call.
//
// Skipped (not failed) where tmux is unavailable — every other harness test in
// this directory mocks tmux precisely so the suite does not require it.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const t = require('../tmux.js');

function haveTmux() {
  try {
    execFileSync('tmux', ['-V'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}
const skip = haveTmux() ? false : 'tmux is not installed';

// Throwaway sessions, named so a leaked one is obvious and never collides with
// a real bc- session (those are `bc-<hex>`; these carry a word).
const PANE = 'bc-littest-pane';
const OTHER = 'bc-littest-other';
const tgt = (s) => `=${s}:=probe`;

async function makeSession(name) {
  await t.tryTmux('kill-session', '-t', `=${name}:`);
  await t.tmux('new-session', '-d', '-s', name, '-n', 'probe', '-c', '/tmp');
}
async function lastLine(name) {
  const out = await t.capture(tgt(name), 5);
  return out.trim().split('\n').pop();
}
// Clear whatever is sitting at the shell prompt (C-u), so each payload is read
// on a clean line.
async function clearLine(name) {
  await t.tmux('send-keys', '-t', tgt(name), 'C-u');
  await t.sleep(80);
}

// Every one of these was SWALLOWED as a flag before `--` was added; -t is the
// dangerous one (it retargets), the rest are silent data loss.
const FLAG_SHAPED = ['-R', '--', '-l', '-N5', '-t=' + OTHER + ':=probe', '-', '-X', '--help'];

test('flag-shaped text is TYPED, never parsed as tmux flags', { skip }, async () => {
  await makeSession(PANE);
  try {
    await t.sleep(250);
    for (const payload of FLAG_SHAPED) {
      await clearLine(PANE);
      await t.sendLiteral(tgt(PANE), payload);
      await t.sleep(150);
      const line = await lastLine(PANE);
      assert.ok(line.endsWith(payload),
        `${JSON.stringify(payload)} should sit at the prompt, got ${JSON.stringify(line)}`);
    }
  } finally { await t.tryTmux('kill-session', '-t', `=${PANE}:`); }
});

test('text cannot retarget send-keys at a pane the caller never named', { skip }, async () => {
  await makeSession(PANE);
  await makeSession(OTHER);
  try {
    // Wait for BOTH shells to paint their prompt before snapshotting the
    // victim — a baseline taken from a blank pane would match a wiped one.
    await t.sleep(700);
    const otherBefore = await lastLine(OTHER);
    assert.ok(otherBefore, 'the victim pane painted a prompt before we snapshot it');

    // The attack: type into PANE, but with a payload that used to be read as
    // `-t <OTHER>` and hand the whole command to somebody else's pane.
    await clearLine(PANE);
    await t.sendLiteral(tgt(PANE), '-t=' + OTHER + ':=probe');
    await t.sleep(200);
    // A second write that WOULD have landed in OTHER under the old parse.
    await t.sendLiteral(tgt(PANE), 'BREACH');
    await t.sleep(200);

    assert.match(await lastLine(PANE), /-t=.*BREACH$/, 'both writes stayed in the authorised pane');
    assert.strictEqual(await lastLine(OTHER), otherBefore, 'the unauthorised pane was never touched');
  } finally {
    await t.tryTmux('kill-session', '-t', `=${PANE}:`);
    await t.tryTmux('kill-session', '-t', `=${OTHER}:`);
  }
});

test('sendKey still delivers every key name the port grammar allows', { skip }, async () => {
  await makeSession(PANE);
  try {
    await t.sleep(250);
    const { KEY_RE } = require('../port.js');
    // The punctuation controls the client emits and the letters/named keys.
    // C-[ is Escape on a lot of muscle memory — it must not 502 and it must not
    // be rejected by tmux either.
    for (const key of ['Enter', 'BSpace', 'BTab', 'Up', 'PageDown', 'DC', 'IC',
      'Escape', 'C-c', 'C-a', 'C-[', 'C-\\', 'C-]', 'C-^', 'C-_']) {
      assert.match(key, KEY_RE, `${key} must pass the port grammar`);
      await t.sendKey(tgt(PANE), key); // rejects → this throws and the test fails
    }
  } finally { await t.tryTmux('kill-session', '-t', `=${PANE}:`); }
});

test('multi-line text still rides the buffer path and lands intact', { skip }, async () => {
  await makeSession(PANE);
  try {
    await t.sleep(250);
    await clearLine(PANE);
    // Leading '-' AND newlines: the branch that was always safe, kept safe.
    await t.sendLiteral(tgt(PANE), '-R first\n-R second');
    await t.sleep(250);
    const out = await t.capture(tgt(PANE), 10);
    assert.match(out, /-R first/);
    assert.match(out, /-R second/);
  } finally { await t.tryTmux('kill-session', '-t', `=${PANE}:`); }
});

// The cap in port.js is a claim about tmux, and only tmux can confirm it: a
// full-size payload must actually LAND, not 502. tmux packs one command into a
// single imsg, so the ceiling is on the whole argv — target included.
test('a payload at PANE_INPUT_MAX actually gets through send-keys', { skip }, async () => {
  await makeSession(PANE);
  try {
    await t.sleep(250);
    await clearLine(PANE);
    const { PANE_INPUT_MAX } = require('../port.js');
    await t.sendLiteral(tgt(PANE), 'x'.repeat(PANE_INPUT_MAX)); // rejects → test fails
  } finally { await t.tryTmux('kill-session', '-t', `=${PANE}:`); }
});

// Past the ceiling tmux fails, and execFile builds its message out of the FULL
// argv — so the error used to carry the entire payload out as an HTTP body.
// A 20 KB paste produced a 20 KB error.
test('a payload tmux refuses does not come back inside the error', { skip }, async () => {
  await makeSession(PANE);
  try {
    await t.sleep(250);
    const payload = 'z'.repeat(64 * 1024); // past any imsg budget, whatever the target
    const err = await t.sendLiteral(tgt(PANE), payload).then(() => null, (e) => e);
    assert.ok(err, 'tmux must reject a payload this size');
    assert.ok(err.message.length < 600, `error was ${err.message.length} chars: not truncated`);
    assert.ok(!err.message.includes(payload), 'the payload must not ride the error out');
    assert.match(err.message, /tmux send-keys/, 'the command is still named');
    // tmux 3.4 says "command too long" here and "failed to send command" just
    // past the imsg budget; either way its reason must outlive the truncation.
    assert.match(err.message, /command too long|failed to send command/,
      "tmux's own reason survives truncation");
  } finally { await t.tryTmux('kill-session', '-t', `=${PANE}:`); }
});
