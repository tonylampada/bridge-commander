// Speaker over the browser's own window.speechSynthesis.
//
// Reliability hazards this guards against:
//  - overlapping utterances wedging the queue (rapid messages) -> cancel-and-
//    speak-latest: a new message supersedes the old so the newest is always heard;
//  - Chrome/Safari idle auto-pause and the ~15s mid-utterance cutoff -> a keepalive
//    that resume()s while speaking, plus splitting long text into sentence chunks;
//  - a stuck/failed utterance killing all later speech -> onerror resets the engine
//    and retries the chunk once, then moves on instead of dying silently.

// split into sentence-sized chunks so no single utterance is long enough to hit
// the engine's mid-utterance cutoff; hard-wrap anything still oversized.
function chunkText(s) {
  const parts = s.match(/[^.!?\n]+[.!?]*|\n+/g) || [s];
  const out = [];
  let buf = '';
  for (let p of parts) {
    p = p.replace(/\s+/g, ' ').trim();
    if (!p) continue;
    if (buf && (buf + ' ' + p).length > 180) { out.push(buf); buf = ''; }
    buf = buf ? buf + ' ' + p : p;
    while (buf.length > 200) { out.push(buf.slice(0, 200)); buf = buf.slice(200).trim(); }
  }
  if (buf) out.push(buf);
  return out.length ? out : [s];
}

export function browserSpeaker() {
  let queue = [];        // remaining chunks of the CURRENT message
  let gen = 0;           // bumped per message; stale utterance callbacks are ignored
  let retried = false;
  let keepalive = null;
  let settle = null;     // resolve of the in-flight speak()
  let paused = false;    // the transport asked for silence — the keepalive must respect it

  function stopKeepalive() { if (keepalive) { clearInterval(keepalive); keepalive = null; } }
  function startKeepalive() {
    stopKeepalive();
    keepalive = setInterval(() => {
      if (!window.speechSynthesis) return stopKeepalive();
      if (paused) return;                      // else the anti-idle resume() would undo the pause
      if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.resume();
      else stopKeepalive();
    }, 7000);
  }
  function finish(my) {
    if (my !== gen) return;
    stopKeepalive();
    const done = settle; settle = null;
    if (done) done();
  }
  function playNext(my) {
    if (my !== gen) return;                    // a newer message superseded this one
    if (!queue.length) return finish(my);      // message done
    const u = new SpeechSynthesisUtterance(queue[0]);
    const v = voiceObj(current.voice) || defaultVoice();
    if (v) { u.voice = v; u.lang = v.lang; }   // else: default voice (voices may still be loading)
    u.onend = () => { if (my !== gen) return; queue.shift(); retried = false; playNext(my); };
    u.onerror = () => {
      if (my !== gen) return;                  // 'canceled'/'interrupted' from a newer speak(): ignore
      if (!retried) {                          // recover once: reset the engine, retry this chunk
        retried = true;
        try { speechSynthesis.cancel(); } catch (e) {}
        setTimeout(() => playNext(my), 150);
      } else { retried = false; queue.shift(); playNext(my); } // give up on this chunk, continue
    };
    try { speechSynthesis.resume(); speechSynthesis.speak(u); }
    catch (e) { queue.shift(); playNext(my); }
  }
  // A browser voice's identity is its name|lang pair — the same token the picker
  // stores, so nothing downstream has to know it is not an opaque engine id.
  function list() { return window.speechSynthesis ? speechSynthesis.getVoices() : []; }
  function idOf(v) { return v.name + '|' + v.lang; }
  function voiceObj(id) { return id ? list().find((v) => idOf(v) === id) || null : null; }
  function defaultVoice() {
    const all = list();
    return all.find((v) => /pt[-_]BR/i.test(v.lang)) || all.find((v) => /^pt/i.test(v.lang)) || null;
  }
  let current = {};

  return {
    id: 'browser',
    key: 'bc-voice',                           // where the picker persists its choice
    // Voices arrive asynchronously in every browser; poll briefly rather than
    // answering with the empty list the first call would otherwise see.
    voices() {
      return new Promise((resolve) => {
        let tries = 0;
        const take = () => list().map((v) => ({ id: idOf(v), name: v.name, lang: v.lang }));
        if (take().length) return resolve(take());
        const t = setInterval(() => {
          if (take().length || ++tries > 10) { clearInterval(t); resolve(take()); }
        }, 300);
      });
    },
    speak(text, opts) {
      return new Promise((resolve, reject) => {
        if (!window.speechSynthesis) return reject(new Error('no speechSynthesis'));
        const my = ++gen;
        current = opts || {};
        queue = chunkText(text);
        retried = false;
        paused = false;                        // a new message always starts speaking
        settle = resolve;
        startKeepalive();
        // Only do the cancel-then-wait dance when something is actually in
        // flight: speaking straight away keeps a click-gesture unlock intact.
        if (speechSynthesis.speaking || speechSynthesis.pending) {
          try { speechSynthesis.cancel(); } catch (e) {}
          setTimeout(() => playNext(my), 60);  // let cancel() settle before speak() (Chrome quirk)
        } else playNext(my);
      });
    },
    cancel() {
      gen++; queue = []; paused = false; stopKeepalive();
      try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
      const done = settle; settle = null;
      if (done) done();                        // a cancelled message is finished, not failed
    },
    // The engine's own pause/resume. Reversible, unlike cancel(): the queue and
    // the utterance mid-flight are untouched, so resume picks the word back up.
    pause() {
      paused = true;
      try { if (window.speechSynthesis) speechSynthesis.pause(); } catch (e) {}
    },
    resume() {
      paused = false;
      try { if (window.speechSynthesis) speechSynthesis.resume(); } catch (e) {}
    },
  };
}
