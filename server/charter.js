'use strict';
// The charter is the one thing on a lieutenant the board stored but never used:
// prose an agent reads at launch. So it lives where the agent already looks —
// `lieutenants/<id>/README.md` in the workspace, the lieutenant's standing
// memory file — and not in board.json. One path, shared by the server (which
// reads it into the launch prompt) and the CLI (which writes it from
// --charter-file and shows its first line in `lieutenant list`).

const fs = require('fs');
const path = require('path');

function charterPath(workspace, id) {
  return path.join(workspace, 'lieutenants', String(id), 'README.md');
}
function readCharter(workspace, id) {
  try { return fs.readFileSync(charterPath(workspace, id), 'utf8').trim(); }
  catch (e) { return ''; }
}
function writeCharter(workspace, id, text) {
  const file = charterPath(workspace, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, /\n$/.test(text) ? text : text + '\n');
  return file;
}

module.exports = { charterPath, readCharter, writeCharter };
