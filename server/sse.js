'use strict';
// sse — the one place an event-stream response is opened. Node built-ins only.
//
// Behind the Cloudflare tunnel a stream answered with plain `no-cache` got
// compressed and buffered at the edge: board pushes reached the phone after
// the Web Push for the same message. `no-transform` forbids the edge from
// touching the body, `X-Accel-Buffering: no` asks any nginx-style proxy not to
// hold it, and `identity` says nothing here is compressed. The headers go out
// at once with a `:ok` comment, so a proxy that waits for the first body bytes
// before forwarding has some.
//
// Every opened stream joins one heartbeat: a NAMED `ping` event (not a comment)
// because comments are invisible to EventSource and the client's staleness
// watchdog listens for it. The same tick keeps idle proxies from dropping
// pane and sysload streams. A stream leaves the heartbeat when its request
// closes.

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Content-Encoding': 'identity',
  'X-Accel-Buffering': 'no',
  Connection: 'keep-alive',
};

const PING = 'event: ping\ndata: {}\n\n';
const streams = new Set();
let timer = null;

function ensureHeartbeat(ms) {
  if (timer) return;
  timer = setInterval(() => { for (const res of streams) res.write(PING); }, ms);
  timer.unref();
}

// sseOpen(req, res, { pingMs }) — write the headers, flush, say `:ok`, and
// join the heartbeat until `req` closes. A stream that ends right after (a
// guard event) can call it the same way; res.end() fires the close.
function sseOpen(req, res, opts) {
  res.writeHead(200, SSE_HEADERS);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(':ok\n\n');
  ensureHeartbeat((opts && opts.pingMs) || 15000);
  streams.add(res);
  const leave = () => streams.delete(res);
  req.on('close', leave);
  res.on('close', leave);
}

module.exports = { sseOpen, SSE_HEADERS };
