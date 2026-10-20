'use strict';
// A lieutenant's page: free-form HTML the lieutenant writes about the topics it
// owns, at `<workspace>/lieutenants/<id>/page/`. The board only hosts it — it
// never writes there. Served static at /lt/<id>/, and stamped with the newest
// mtime under the folder so the captain sees when a refresh schedule slips.

const fs = require('fs');
const path = require('path');

function pageDir(workspace, id) {
  return path.join(workspace, 'lieutenants', String(id), 'page');
}

// The file a request under /lt/<id>/ names, or null. `rel` is the decoded path
// after the id's slash ('' for the folder itself). Anything that resolves
// outside page/ — a `..`, an absolute path, a symlink pointing out — is null,
// the same answer as a file that is not there.
function resolvePageFile(workspace, id, rel) {
  let root;
  try { root = fs.realpathSync(pageDir(workspace, id)); } catch (e) { return null; }
  if (String(rel).includes('\0')) return null;
  let file = path.resolve(root, '.' + path.sep + String(rel));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  try {
    file = fs.realpathSync(file);
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.statSync(file).isFile()) return null;
  } catch (e) { return null; }
  return file;
}

// {updated: ISO} when the lieutenant has a page (page/index.html exists), else
// null. Newest mtime of anything under page/, folders included — so a deleted
// asset moves the stamp too. Bounded: a page is a handful of files, and this
// runs on every board broadcast.
const WALK_MAX = 500;
function pageInfo(workspace, id) {
  const root = pageDir(workspace, id);
  try { if (!fs.statSync(path.join(root, 'index.html')).isFile()) return null; }
  catch (e) { return null; }
  let newest = 0, seen = 0;
  const stack = [root];
  while (stack.length && seen < WALK_MAX) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    try { newest = Math.max(newest, fs.statSync(dir).mtimeMs); } catch (e) {}
    for (const ent of entries) {
      if (++seen > WALK_MAX) break;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(p); continue; }
      try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch (e) {}
    }
  }
  return { updated: new Date(newest).toISOString() };
}

module.exports = { pageDir, resolvePageFile, pageInfo };
