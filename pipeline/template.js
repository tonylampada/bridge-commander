'use strict';
// template — the whole templating language the pipeline file gets. Two forms:
//
//   {{name}}              substituted with the variable's value ('' when empty)
//   {{#name}}…{{/name}}   the block is DROPPED when the variable is empty
//
// That is all. Not a general template engine on purpose: every name is checked
// against the run's variable list before a single token is spent, and a
// language with expressions in it could not be checked that way.
//
// Names are dotted words (`card.title`, `run.output`); the variable map is
// FLAT, keyed by the dotted name, so there is no traversal and no way for a
// half-present object to render "undefined" into a prompt.

const SECTION = /\{\{#([\w.]+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g;
const VAR = /\{\{([\w.]+)\}\}/g;
const ANY_TAG = /\{\{([#/]?)([\w.]+)\}\}/g;

function isEmpty(v) {
  return v === undefined || v === null || v === false || String(v).trim() === '';
}

// render(text, vars) -> string. Throws on a name the map does not carry —
// validation is supposed to have caught it, and rendering "" for a typo is
// exactly the silent failure this pipeline is trying not to have.
function render(text, vars) {
  const out = String(text)
    .replace(SECTION, (_m, name, body) => (isEmpty(vars[name]) ? '' : body))
    .replace(VAR, (_m, name) => {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) {
        throw new Error(`unknown variable {{${name}}}`);
      }
      return isEmpty(vars[name]) ? '' : String(vars[name]);
    });
  return out;
}

// refs(text) -> { vars: Set, sections: Set, unbalanced: [names] }
// Every name the text mentions, and the section tags that never close (or
// close without opening) — an unbalanced pair renders as literal `{{#x}}`
// braces in a prompt, which is the kind of thing you only notice in the
// agent's confused reply.
function refs(text) {
  const vars = new Set();
  const sections = new Set();
  const open = [];
  const unbalanced = [];
  for (const m of String(text).matchAll(ANY_TAG)) {
    const [, sigil, name] = m;
    if (sigil === '#') {
      sections.add(name);
      open.push(name);
    } else if (sigil === '/') {
      if (open[open.length - 1] === name) open.pop();
      else unbalanced.push(name);
    } else {
      vars.add(name);
    }
  }
  return { vars, sections, unbalanced: unbalanced.concat(open) };
}

module.exports = { render, refs };
