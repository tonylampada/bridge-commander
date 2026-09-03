'use strict';
// tmux-mock — patches the shared harness/tmux.js exports so a tmux-TUI
// adapter's spawn() runs end-to-end with NO real tmux process, while
// recording every call the adapter (via tmux-session.js) makes. This is what
// lets claude-tmux.test.js / codex-tmux.test.js pin "the brief never rides
// on the command line" as a plain, fast, deterministic unit test: mock
// submit() records exactly what text got typed into the composer, separate
// from the launch line typed by sendLiteral() at launch.
//
// Safe to use because tmux-session.js does `const t = require('./tmux.js')`
// and calls `t.foo(...)` at call time — mutating the exports object here
// (the SAME cached module instance) is visible to every adapter.
const tmuxMod = require('../tmux.js');

const PATCHED = ['tmux', 'tryTmux', 'tmuxRead', 'sleep', 'sendLiteral', 'sendKey', 'capture', 'captureStyled', 'submit'];

// mockTmux({readyTail}) -> { calls, restore() }
// readyTail — the string returned by capture()/captureStyled() (the adapter's
// trust/ready regexes are tested against it) so launch-settle resolves fast.
//
// readyTail may also be an ARRAY of screens, handed out one per capture and
// then held on the last. That is how a launch that has to walk THROUGH a dialog
// is testable: give it [picker, readyUI] and the settle loop must answer the
// first before it ever sees the second.
//
// readFails — make every STRICT read (tmuxRead) throw, the way a tmux that
// cannot be run at all answers: not "the window is gone", but "I could not
// look". The loose reads (tryTmux) are unaffected, exactly as in the real
// plumbing.
function mockTmux({ readyTail, readFails }) {
  const screens = Array.isArray(readyTail) ? readyTail.slice() : null;
  const nextScreen = () => (screens ? (screens.length > 1 ? screens.shift() : screens[0]) : readyTail);
  const calls = [];
  const original = {};
  for (const name of PATCHED) original[name] = tmuxMod[name];

  tmuxMod.sleep = async () => {};
  tmuxMod.tmux = async (...args) => { calls.push({ fn: 'tmux', args }); return ''; };
  tmuxMod.tryTmux = async (...args) => {
    calls.push({ fn: 'tryTmux', args });
    // paneCommand's display-message probe must answer a live, non-shell
    // command so launch-settle's poll loop proceeds past the "not up yet" check.
    if (args[0] === 'display-message' && args.includes('#{pane_current_command}')) return 'agent';
    return null; // has-session / list-windows: "not found" — claimPaneNames proceeds
  };
  // the strict reader: same answers as tryTmux, except that a read FAILURE is
  // an error rather than a null
  tmuxMod.tmuxRead = async (...args) => {
    calls.push({ fn: 'tmuxRead', args });
    if (readFails) throw new Error('tmux: no server on socket');
    if (args[0] === 'display-message' && args.includes('#{pane_current_command}')) return 'agent';
    return null;
  };
  tmuxMod.sendLiteral = async (target, text) => { calls.push({ fn: 'sendLiteral', args: [target, text] }); };
  tmuxMod.sendKey = async (...args) => { calls.push({ fn: 'sendKey', args }); };
  tmuxMod.capture = async (...args) => { calls.push({ fn: 'capture', args }); return nextScreen(); };
  tmuxMod.captureStyled = async (...args) => { calls.push({ fn: 'captureStyled', args }); return nextScreen(); };
  tmuxMod.submit = async (target, text, opts) => {
    calls.push({ fn: 'submit', args: [target, text, opts] });
    return 'empty';
  };

  return {
    calls,
    restore() { for (const name of PATCHED) tmuxMod[name] = original[name]; },
  };
}

module.exports = { mockTmux };
