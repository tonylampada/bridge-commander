# Lieutenant page actions — example

A lieutenant folder (`lieutenants/<id>/`) with one action and a page that uses it: add, edit
and delete on a JSON list. The board serves it live at **`/lt/_demo/`** (copied on first use
into `<workspace>/.bridge-commander/lt-demo/`; comments and notified actions go to whoever is
on the line). It is also the test fixture (`test/ltactions.test.js`).

- `actions/items` — the executable. JSON in on stdin, JSON out on stdout, writes `page/data/items.json`.
- `page/index.html` — renders from `data/items.json`; imports `/lt/_sdk/actions.js`.
- `page/data/items.json` — the data.

To give a real lieutenant the same thing, copy `actions/items` into `lieutenants/<id>/actions/`
and adapt the page. The contract is in the top-level README, "Lieutenant page actions".
