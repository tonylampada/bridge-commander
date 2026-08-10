'use strict';
// The TTS engine, served from the board's own origin.
//
// `/api/tts/<rest>` goes to `<engine>/<rest>` and nothing else happens: same
// method, same path, same query, same headers, same status, same bytes. No
// cache, no retry, no defaults filled in, no knowledge of which paths the
// engine has. A condition on a path or a body in this file is a bug.
//
// Both directions STREAM. Audio starts playing while synthesis is still
// running, so buffering a response here would put the whole 30-second wait back.
//
// A client that hangs up kills the upstream request. That is load-bearing, not
// tidiness: the browser aborts a fetch precisely so the ENGINE stops
// synthesizing, and an abandoned synthesis that overlaps the next request takes
// voxcpm2's CUDA context down with it (see ui/js/speech.js).
const http = require('http');
const https = require('https');

// engine: the base url from config (no trailing slash). rest: everything after
// the prefix, already including its leading slash and query string, still
// percent-encoded exactly as the browser sent it.
function proxyTts(req, res, engine, rest) {
  const target = engine + rest;
  const mod = target.startsWith('https:') ? https : http;
  const headers = Object.assign({}, req.headers);
  delete headers.host; // the engine's host, not the board's — everything else rides along
  const up = mod.request(target, { method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  // Upstream is done the moment its response ends; only a hangup BEFORE that is
  // worth aborting, and aborting after it would take a pooled socket with it.
  let done = false;
  up.on('response', (r) => r.once('end', () => { done = true; }));
  // Nothing to say once the status line is out (or once the client is gone —
  // which is how a deliberate abort comes back here): drop the connection and
  // let the browser see the truncation, the same as talking to the engine direct.
  up.on('error', (e) => {
    if (res.headersSent || res.destroyed) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  });
  res.on('close', () => { if (!done) up.destroy(); });
  req.pipe(up);
}

module.exports = { proxyTts };
