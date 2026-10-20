// Read-only board access for a lieutenant's page (served at /lt/_bc.js).
//   <script src="/lt/_bc.js"></script>
//   const cards = await bc.cards('monica');   // live cards owned by monica (all, without an id)
//   const mine  = await bc.needsYou('monica'); // cards waiting on the captain
//   const doc   = await bc.board();           // the whole /api/board payload
// Every call fetches afresh; nothing here writes.
(function () {
  async function board() {
    const r = await fetch('/api/board', { cache: 'no-store' });
    if (!r.ok) throw new Error('board: HTTP ' + r.status);
    return r.json();
  }
  async function cards(owner) {
    const all = (await board()).cards || [];
    return owner ? all.filter((c) => c.owner === owner) : all;
  }
  // Waiting on the captain: in his review column, or a worker flagged needs-you.
  async function needsYou(owner) {
    return (await cards(owner)).filter((c) => c.column === 'review' ||
      (c.status && c.status.worker && c.status.worker.state === 'needs-you'));
  }
  window.bc = { board, cards, needsYou };
})();
