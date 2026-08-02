#!/usr/bin/env node
// dev/room-shots.js — photograph the room, with no headset and no display.
//
//   node dev/room-shots.js [--out DIR] [--size WxH] [--url URL] [--keep]
//
// One command. It starts the frontend playground (dev/ui-server.js, the same
// fixture board), drives a headless Chrome at ui/bridge3d.html with the dev
// flags on, enters a REAL immersive session through the emulated runtime, poses
// the head at each viewpoint in ui/js/bridge3d/viewpoints.js, and writes a PNG
// per viewpoint plus a manifest. Default output: dev/shots/.
//
// Node built-ins only — no Playwright, no Puppeteer, nothing to install. Chrome
// speaks the DevTools Protocol over a WebSocket and Node has had a WebSocket
// client since 22; the whole driver below is that plus JSON.
//
// What it can and cannot tell you: a photograph proves the room did not go
// blank and shows what it looks like. It does NOT prove a target is 6° — exact
// pixels differ across drivers and would only train you to ignore the check.
// The arc is measured in test/bridge3d.test.js.
//
// So this run asserts two things and no more. Structural: every frame has
// colour in it. And POINTABLE: it aims the head at one of each kind of thing in
// the room and checks the ray lights it up, because a room where the ray reaches
// nothing photographs perfectly and is completely dead — which it was, once,
// behind a glyph layer two millimetres in front of the colliders.
//
// See ui/js/bridge3d/README.md, and `vr-design` for every design number.
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

// ---------- arguments ----------

function parseArgs(argv) {
  const a = { out: path.join(ROOT, 'dev', 'shots'), width: 1280, height: 960, url: '', keep: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = path.resolve(argv[++i] || '');
    else if (k === '--url') a.url = String(argv[++i] || '');
    else if (k === '--keep') a.keep = true;
    else if (k === '--size') {
      const m = /^(\d+)x(\d+)$/.exec(argv[++i] || '');
      if (!m) throw new Error('bad --size (want WxH, e.g. 1280x960)');
      a.width = +m[1]; a.height = +m[2];
    } else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error('unknown argument: ' + k);
  }
  return a;
}

// ---------- chrome ----------

const CHROME_CANDIDATES = [
  process.env.CHROME, process.env.CHROME_PATH,
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (c.includes('/')) { if (fs.existsSync(c)) return c; continue; }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(dir, c);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('no Chrome found — install one or set CHROME=/path/to/chrome');
}

// Launch headless and hand back the DevTools endpoint it prints to stderr. The
// port is 0 (let the OS pick) so two runs never collide.
function launchChrome(bin, profileDir, width, height) {
  const child = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=1',
    '--window-size=' + width + ',' + height,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error('chrome never printed a debugger url:\n' + err)), 30000);
    child.stderr.on('data', (d) => {
      err += d;
      const m = /ws:\/\/[^\s]+/.exec(err);
      if (!m) return;
      clearTimeout(timer);
      child.stderr.removeAllListeners('data');
      child.stderr.resume();
      resolve({ child, wsUrl: m[0], port: (/127\.0\.0\.1:(\d+)/.exec(m[0]) || [])[1] });
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('chrome exited (' + code + '):\n' + err)); });
  });
}

// ---------- the devtools protocol, in about thirty lines ----------

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('devtools socket refused: ' + wsUrl)), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (!m.id) return (listeners.get(m.method) || (() => {}))(m.params);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  return { send, on: (method, fn) => listeners.set(method, fn), close: () => ws.close() };
}

async function evaluate(cdp, expression, opts) {
  const r = await cdp.send('Runtime.evaluate',
    Object.assign({ expression, awaitPromise: true, returnByValue: true }, opts || {}));
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('in the page: ' + ((d.exception && d.exception.description) || d.text));
  }
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cdp, expression, what, ms = 30000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await evaluate(cdp, '!!(' + expression + ')').catch(() => false)) return;
    if (Date.now() > until) throw new Error('gave up waiting for ' + what);
    await sleep(150);
  }
}

// ---------- the run ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node dev/room-shots.js [--out DIR] [--size WxH] [--url URL] [--keep]');
    return 0;
  }

  const { VIEWPOINTS, PROBES } = await import(pathToFileURL(path.join(ROOT, 'ui', 'js', 'bridge3d', 'viewpoints.js')));

  // The board behind the room: the frontend playground, unless a URL was given
  // (point --url at a live server to photograph a real board instead).
  let dev = null;
  let base = args.url;
  if (!base) {
    const { createDevServer } = require(path.join(ROOT, 'dev', 'ui-server.js'));
    dev = createDevServer({});
    await new Promise((r) => dev.server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + dev.server.address().port;
  }
  const url = base.replace(/\/+$/, '') + '/ui/bridge3d.html?capture=1&xr=emulate';

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'room-shots-'));
  const bin = findChrome();
  const { child, port } = await launchChrome(bin, profile, args.width, args.height);

  let cdp = null;
  const shots = [];
  const probes = [];
  try {
    // The page target, found through the http side of the protocol.
    const list = await (async () => {
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch('http://127.0.0.1:' + port + '/json/list').then((x) => x.json());
          const t = r.find((x) => x.type === 'page');
          if (t) return t;
        } catch (e) { /* still starting */ }
        await sleep(150);
      }
      throw new Error('chrome never offered a page target');
    })();
    cdp = await connect(list.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Anything the room says to a console it thinks nobody is reading. Without
    // this a broken import is "gave up waiting" and nothing else, which is a
    // miserable half hour.
    const errors = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      errors.push((d.exception && d.exception.description) || d.text || 'exception');
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      errors.push((p.args || []).map((a) => a.value || a.description || a.type).join(' '));
    });

    await cdp.send('Page.navigate', { url });
    const complain = (e) => {
      if (errors.length) console.error('the page complained:\n  ' + errors.join('\n  '));
      throw e;
    };
    await waitFor(cdp, 'window.__bridge && document.getElementById("gate").classList.contains("ready")',
      'the room to load and the board to answer').catch(complain);
    await waitFor(cdp, 'window.__xr', 'the emulated headset to install').catch(complain);

    // Enter, as a person does: the same button, with a user gesture behind it,
    // so this exercises requestSession and not a private back door.
    await evaluate(cdp, 'document.getElementById("enter").click()', { userGesture: true });
    await waitFor(cdp, 'window.__xr.presenting', 'the immersive session to start').catch(complain);
    console.log('· immersive session running (emulated) at ' + url);

    fs.mkdirSync(args.out, { recursive: true });

    let scene = '';
    for (const v of VIEWPOINTS) {
      if (v.scene !== scene) {
        scene = v.scene;
        await evaluate(cdp, setScene(scene));
        await evaluate(cdp, 'window.__xr.frames(3)');
      }
      const aim = await evaluate(cdp, 'window.__xr.look(' + JSON.stringify(v.name) + ')');
      await evaluate(cdp, 'window.__xr.frames(4)');       // let the room settle and repaint
      const stats = await evaluate(cdp, 'window.__xr.frameStats()');
      // What the room costs to draw, per shot — the figure that says whether a
      // world built out of real objects still fits an 11 ms frame.
      const room = await evaluate(cdp, 'window.__bridge.stats()');
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(args.out, v.name + '.png');
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      // Structural only: did anything land on the canvas. Not a pixel compare.
      const blank = !stats || stats.colours < 12 || stats.litFraction < 0.005;
      shots.push({ name: v.name, scene: v.scene, why: v.why, file: path.relative(ROOT, file), aim, stats, room, ok: !blank });
      console.log((blank ? '✗ ' : '· ') + v.name.padEnd(14)
        + 'yaw ' + aim.yaw.toFixed(1).padStart(6) + '°  pitch ' + aim.pitch.toFixed(1).padStart(6) + '°  '
        + (stats ? stats.colours + ' colours, ' + (stats.litFraction * 100).toFixed(1) + '% lit' : 'NO FRAME')
        + (room ? ', ' + room.calls + ' draws' : '')
        + '  → ' + path.relative(ROOT, file));
    }

    // Can the ray still land? A photograph never shows this, and the ways it
    // breaks are all invisible — a glyph layer in front of the colliders, a
    // hidden panel that is still pointable at, a pointer flag the library
    // rewrites the moment you set it. So the run points at one of each kind of
    // thing and checks it lights up.
    await evaluate(cdp, setScene('world'));
    for (const p of PROBES) {
      await evaluate(cdp, `window.__xr.aim(${p.yaw}, ${p.pitch})`);
      await evaluate(cdp, 'window.__xr.frames(4)');
      const lit = await evaluate(cdp, 'window.__bridge.lit()');
      const on = (lit || []).find((t) => t.name === p.expect);
      probes.push({ ...p, lit, ok: !!on });
      console.log((on ? '· ' : '✗ ') + ('ray on ' + p.name).padEnd(24)
        + (on ? on.state + ' at ' + on.distance.toFixed(2) + ' m' : 'NOTHING — the ray reaches nothing there'));
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      url, size: args.width + 'x' + args.height,
      chrome: bin, board: args.url ? 'live server' : 'dev/ui-server.js fixture',
      note: 'Screenshots are structural evidence only — every arc figure is asserted in test/bridge3d.test.js, and every design number lives in the vr-design skill.',
      shots, probes,
    };
    fs.writeFileSync(path.join(args.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    if (errors.length) console.error('\nthe page complained:\n  ' + errors.join('\n  '));
    const bad = shots.filter((s) => !s.ok);
    const dead = probes.filter((p) => !p.ok);
    if (bad.length) console.log('\n' + bad.length + ' blank frame(s): ' + bad.map((s) => s.name).join(', '));
    if (dead.length) console.log((bad.length ? '' : '\n') + 'the ray lands on nothing at: ' + dead.map((p) => p.name).join(', '));
    if (!bad.length && !dead.length) {
      console.log('\n' + shots.length + ' shots in ' + path.relative(ROOT, args.out)
        + '/ (+ manifest.json), and the ray lands on all ' + probes.length + ' kinds of thing');
    }
    return bad.length || dead.length ? 1 : 0;
  } finally {
    if (cdp) try { cdp.close(); } catch (e) { /* going away anyway */ }
    child.kill();
    // Chrome is still flushing its profile while it dies, so wait for it to be
    // gone before deleting underneath it — otherwise cleanup throws ENOTEMPTY
    // and buries whatever really went wrong.
    await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r()));
    if (dev) await dev.stop();
    if (!args.keep) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (e) { console.error('(left ' + profile + ' behind: ' + e.message + ')'); }
    }
  }
}

// What has to be true for a scene's shots to be of anything. Driven through the
// room's own handles (window.__bridge), so the photograph is of the room doing
// its ordinary thing rather than of a rig posing it. The world itself never
// changes — it is a static room, which is the whole point of it — so the only
// scene there is besides 'world' is the flat list standing open in front of it.
function setScene(scene) {
  return `(() => {
    const b = window.__bridge;
    b.openList(${scene === 'list'});
    return b.stats();
  })()`;
}

main().then((code) => process.exit(code), (e) => {
  console.error('room-shots: ' + ((e && e.stack) || e));
  process.exit(1);
});
