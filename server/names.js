'use strict';
// names — workspace-scoped session naming (docs/api/overview.md, harness port:
// "spawned session names are unique per workspace"). Two boards on one machine
// must never collide on tmux session names, so every generated name carries a
// workspace discriminator: the ASCII slug of the workspace basename (truncated)
// plus a short hash of the absolute workspace path. Deterministic — the same
// workspace always yields the same names across restarts.
//
// tmux session names cannot contain dots or colons; everything emitted here is
// [A-Za-z0-9-] only, so emoji or any non-ASCII in a workspace or id never
// reach tmux.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// workspaceDisc(workspace) -> short stable discriminator for the workspace.
// Symlinked paths resolve to one canonical form so the same board gets the
// same discriminator no matter how it was addressed.
function workspaceDisc(workspace) {
  let abs = path.resolve(workspace);
  try { abs = fs.realpathSync(abs); } catch (e) { /* not on disk yet — hash the resolved form */ }
  const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 6);
  const slug = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 12).replace(/-+$/, '');
  return slug ? slug + '-' + hash : hash;
}

function safe(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '-'); }

function lieutenantSession(workspace, id) {
  return 'bc-' + workspaceDisc(workspace) + '-lt-' + safe(id);
}

// workerWindow(cardId) -> tmux window name for a card's worker inside its
// owning lieutenant's session (papercut #8). The 'w-' prefix guarantees the
// name can never read as a bare number, which tmux would parse as a window
// INDEX instead of a name. No workspace discriminator: the enclosing
// lieutenant session already carries it, and card ids are unique per board.
function workerWindow(cardId) {
  return 'w-' + safe(cardId);
}

module.exports = { workspaceDisc, lieutenantSession, workerWindow };
