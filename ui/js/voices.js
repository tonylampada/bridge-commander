// The catalogue, and whose voice speaks. Board policy, no DOM and no playback:
// the engine's voice list normalized, the order the pickers offer it in, and the
// inheritance rule (a lieutenant's own voice, else the board's).
//
// speech.js requires a voice and has no default, and neither does this: an id
// the engine does not offer is NO voice, and the board stays silent and says so
// rather than letting the engine choose. An empty voice is exactly how a board
// ends up speaking English in a Portuguese room.

// The whole catalogue, in the engine's own order. It is deliberately NOT filtered
// by the workspace language: voxcpm2 clones from any reference clip, so an `en`
// voice speaking Portuguese is a choice with an accent, not an error. The
// language is on the label so the captain can see what he is picking.
export function fetchVoices(url, lang) {
  return fetch(url + '/v1/voices')
    .then((r) => r.json())
    .then((j) => ((j && j.voices) || [])
      .map((v) => ({ id: v.id, name: v.name, lang: (v.langs || []).join(',') || lang || '' })))
    .catch(() => []);
}

function voiceRank(v) {
  if (/^pt[-_]BR/i.test(v.lang)) return 0;
  if (/^pt/i.test(v.lang)) return 1;
  if (/^en/i.test(v.lang)) return 2;
  return 3;
}

// The offered voices, best-language first. `filter` is the workspace's list of
// name substrings (or null); `keep` is an id to never filter out, so whatever is
// currently chosen stays visible even when the workspace narrows the list.
export function sortedVoices(list, filter, keep) {
  let sorted = (list || []).slice().sort((a, b) =>
    voiceRank(a) - voiceRank(b) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  if (filter && filter.length) {
    const matches = (v) => filter.some((f) => v.name.toLowerCase().includes(f));
    if (sorted.some(matches)) sorted = sorted.filter((v) => matches(v) || v.id === keep);
  }
  return sorted;
}

// WHICH voice speaks: the author's own, else the board's. A lieutenant with no
// voice of its own inherits the board's — that inheritance is the whole rule.
// An id absent from the engine's catalogue (a stale pick, or one made against a
// different engine) is no voice at all; '' comes back, and '' means silence.
export function pickVoice(ownVoice, boardVoice, voices) {
  const has = (id) => !!id && (voices || []).some((v) => v.id === id);
  return has(ownVoice) ? ownVoice : has(boardVoice) ? boardVoice : '';
}
