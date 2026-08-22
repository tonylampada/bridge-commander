// slash.js — what the composer's "/" picker should be showing, as a function of
// the text typed and the commands the target harness reports.
//
// Its own module (not part of chat.js) for the same reason panekeys.js and
// chatmem.js are: chat.js grabs DOM nodes at import time, this is pure, and pure
// is what a unit test can import.
//
// TWO STAGES, because a command name is not always the whole answer. /status and
// /compact take nothing, so completing the name is the end of it. /output-style
// is useless that way — nobody remembers what styles are installed on the
// machine — so a command MAY report `args` (port.js: [{ value, description }])
// and the picker keeps completing past the space:
//
//   "/out"                → stage 'command', the commands starting with "/out"
//   "/output-style "      → stage 'arg', every style that command accepts
//   "/output-style eli"   → stage 'arg', filtered case-insensitively
//   "/compact "           → nothing: a command with no args closes on the space,
//                           exactly as the picker always did
//
// Both stages come back in ONE shape — { name, description, insert } — so the
// caller renders one kind of row and inserts `insert` verbatim, without knowing
// which stage it is in.

// One leading "/" token, no space: the command stage, unchanged from before args
// existed.
const CMD_RE = /^\/\S*$/;
// A complete command name, then whitespace, then the argument. The separator is
// [^\S\n] rather than \s so a newline ends the picker: a composer holding two
// lines is a message being written, not a command being completed.
const ARG_RE = /^(\/\S+)[^\S\n]+([^\n]*)$/;

// slashOptions(value, items) -> { stage, command, query, matches }
//   stage   'command' | 'arg' | null   (null = the picker should be closed)
//   command the command name the arg stage is completing for, else null
//   query   the text being matched against
//   matches [{ name, description, insert }] — insert is the FULL composer value
//           a pick should produce.
// Never throws: `items` straight off the wire may be anything.
export function slashOptions(value, items) {
  const list = Array.isArray(items) ? items : [];
  const v = value == null ? '' : String(value);

  if (CMD_RE.test(v)) {
    const matches = list
      .filter((c) => c && typeof c.name === 'string' && c.name.startsWith(v))
      .map((c) => ({
        name: c.name,
        description: c.description || '',
        // A command that takes an argument completes to "<name> " — the trailing
        // space IS the second stage's trigger, so picking it opens the list of
        // values instead of leaving the captain to guess that there is one.
        insert: c.name + (argsOf(c) ? ' ' : ''),
      }));
    return { stage: 'command', command: null, query: v, matches };
  }

  const m = ARG_RE.exec(v);
  if (!m) return { stage: null, command: null, query: '', matches: [] };
  const cmd = list.find((c) => c && c.name === m[1]);
  const args = cmd && argsOf(cmd);
  if (!args) return { stage: null, command: null, query: '', matches: [] };
  // Everything after the command name is ONE argument, matched whole: a style
  // file's `name:` may contain spaces, and splitting on the first one would make
  // such a style unreachable. Matching the whole remainder is also what lets the
  // pick round-trip without quoting — the harness reads the same string back.
  const q = m[2].toLowerCase();
  const matches = args
    .filter((a) => a && typeof a.value === 'string' && a.value.toLowerCase().startsWith(q))
    .map((a) => ({
      name: a.value,
      description: a.description || '',
      insert: cmd.name + ' ' + a.value,
    }));
  return { stage: 'arg', command: cmd.name, query: m[2], matches };
}

// argsOf(cmd) -> the non-empty args array, or null. `args` is optional metadata
// from a harness that may not send it at all, so anything that is not a
// non-empty array means "this command takes nothing".
function argsOf(cmd) {
  return Array.isArray(cmd.args) && cmd.args.length ? cmd.args : null;
}
