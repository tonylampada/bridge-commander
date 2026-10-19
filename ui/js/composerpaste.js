// composerpaste.js — what a paste into the chat composer does.
//
// Files (a screenshot) become pending attachments. Text is inserted HERE, not
// by the browser, because Chrome drops a paste whose clipboard changes while it
// is being handled: ClipboardCommands::Paste (blink clipboard_commands.cc)
// records the clipboard's sequence number before the paste event and returns
// without inserting if it has moved by the time it would insert. Dictation apps
// (Wispr Flow) write the clipboard, send Cmd+V and restore the clipboard — the
// restore lands mid-paste and the dictation vanishes (MNC-280). The paste event's
// clipboardData is a snapshot taken before that, so its text is still right.
//
// Imports nothing, so a test can drive it with a fake event and field.

// Returns what it did: 'files', 'text', or null (left to the browser).
export function composerPaste(e, { input, doc, addFiles }) {
  const cd = e.clipboardData;
  if (!cd) return null;
  const files = [];
  for (const it of cd.items || []) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); } }
  if (files.length) { e.preventDefault(); addFiles(files); return 'files'; }
  const text = cd.getData('text/plain');
  if (!text) return null;
  e.preventDefault();
  insertText(input, doc, text);
  return 'text';
}

// execCommand keeps the native undo stack and fires beforeinput/input like a
// typed insertion; where it is gone, splice the value and say so ourselves.
function insertText(input, doc, text) {
  let ok = false;
  try { ok = doc.execCommand('insertText', false, text); } catch (err) {}
  if (ok) return;
  input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
