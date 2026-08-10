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
//
// The one deadline: an idle-byte-gap hangup, and nothing else. It knows nothing
// about audio, speech, synthesis, or which path is in flight — it is the gap
// between two bytes from upstream, armed before the first one and re-armed by
// every one after it. A request may legitimately run for minutes as long as
// bytes keep arriving; a total-time cap would truncate every long response and
// is exactly the wrong shape here.
//
// It measures ONE thing: the upstream has gone quiet. It deliberately does not
// measure a slow CLIENT. A client behind on its reading pauses the upstream
// stream (backpressure), and a client still uploading its request has not asked
// the upstream for anything yet — in both cases the silence is ours, not the
// engine's, so the deadline re-arms instead of firing. The connection is cut
// only when the upstream is quiet AND the client is keeping up.
const http = require('http');
const https = require('https');

const IDLE_MS = parseInt(process.env.BC_TTS_IDLE_MS, 10) > 0
  ? parseInt(process.env.BC_TTS_IDLE_MS, 10) : 20000;

// engine: the base url from config (no trailing slash). rest: everything after
// the prefix, already including its leading slash and query string, still
// percent-encoded exactly as the browser sent it.
function proxyTts(req, res, engine, rest) {
  const target = engine + rest;
  const mod = target.startsWith('https:') ? https : http;
  const headers = Object.assign({}, req.headers);
  delete headers.host; // the engine's host, not the board's — everything else rides along
  // Upstream is done the moment its response ends; only a hangup BEFORE that is
  // worth aborting, and aborting after it would take a pooled socket with it.
  let done = false;
  let timer = null;
  const disarm = () => { if (timer) { clearTimeout(timer); timer = null; } };
  // Nothing to say once the status line is out (or once the client is gone —
  // which is how a deliberate abort comes back here): drop the connection and
  // let the browser see the truncation, the same as talking to the engine direct.
  const fail = (e) => {
    disarm();
    up.destroy();
    if (res.headersSent || res.destroyed) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  };
  const ourSilence = () => !req.readableEnded || res.writableNeedDrain || res.writableLength > 0;
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      if (ourSilence()) return arm();
      fail(new Error('no bytes from upstream for ' + IDLE_MS + 'ms'));
    }, IDLE_MS);
  };
  const up = mod.request(target, { method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.on('data', arm);
    r.once('end', () => { done = true; disarm(); });
    r.on('error', () => { disarm(); res.destroy(); });
    r.pipe(res);
  });
  up.on('error', fail);
  res.on('close', () => { disarm(); if (!done) up.destroy(); });
  arm();
  req.pipe(up);
}

module.exports = { proxyTts };
