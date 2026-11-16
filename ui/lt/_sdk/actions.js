// Lieutenant page actions — the write half of a lieutenant page (the read half
// is /lt/_bc.js). Served by the board at /lt/_sdk/actions.js:
//
//   import * as bc from '/lt/_sdk/actions.js';
//   const r = await bc.action('items', { op: 'add', text: 'x' });     // the action's `result`
//   await bc.action('items', { op: 'delete', id }, { notify: true });  // …and wake the lieutenant
//   bc.onChange(() => render());  // after any action on this page, from this tab or another
//
// An action runs lieutenants/<id>/actions/<name> on the board (README: "Lieutenant
// page actions"). A failure rejects with an Error (.status, .body) and shows a
// toast; pass {quiet: true} to handle it yourself. With no onChange handler the
// page reloads after an action — register one to re-render in place instead.
import { toast } from './toast.js';

const m = /^\/lt\/([^/]+)\//.exec(location.pathname);
export const lieutenant = m ? decodeURIComponent(m[1]) : '';
// This tab's tag: the board echoes it on the change event, so the tab that ran
// the action does not re-render twice (it already did, when the POST came back).
const client = Math.random().toString(36).slice(2, 10);
const handlers = new Set();

function changed(ev) {
  if (!handlers.size) { location.reload(); return; }
  for (const h of handlers) { try { h(ev); } catch (e) { console.error(e); } }
}

export async function action(name, args, opts) {
  opts = opts || {};
  let status = 0, body = null;
  try {
    const r = await fetch('/lt/' + encodeURIComponent(lieutenant) + '/action/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: args === undefined ? {} : args, notify: !!opts.notify, client }),
    });
    status = r.status;
    body = await r.json().catch(() => null);
  } catch (e) { body = { ok: false, error: 'board unreachable' }; }
  if (!body || body.ok !== true) {
    const msg = (body && (body.error || body.message)) || 'HTTP ' + status;
    if (!opts.quiet) toast(name + ': ' + msg + (body && body.stderr ? '\n' + body.stderr.slice(-300) : ''), 'error');
    const err = new Error(msg);
    err.status = status;
    err.body = body;
    throw err;
  }
  if (body.message && !opts.quiet) toast(body.message);
  queueMicrotask(() => changed({ id: lieutenant, action: name, local: true, result: body.result }));
  return body.result;
}

// cb({id, action, local}) after every successful action on this lieutenant's
// pages. Returns a function that unregisters it.
export function onChange(cb) {
  handlers.add(cb);
  return () => handlers.delete(cb);
}

// Actions from other tabs and devices arrive on the board's event stream.
if (lieutenant && typeof EventSource !== 'undefined') {
  const es = new EventSource('/api/events');
  es.addEventListener('lt-page-changed', (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch (err) { return; }
    if (d.id === lieutenant && d.by !== client) changed(d);
  });
}

export { toast };
export default { action, onChange, toast, lieutenant };
