// list.js — every card, flat, searchable, one gesture away.
//
// The room is not usable without this and it is not an afterthought: spatial
// memory failing is *expected* rather than exceptional, and this is the answer
// to "where did I put that card". It is also the only honest treatment of a
// list — across a twenty-seven-year survey of immersive analytics not one paper
// contained an abstract 3D visualisation of text data, and Meta, Microsoft and
// Apple say the same thing independently: two-dimensional windows remain the
// efficient way to present documents, and do not add depth to type.
//
// The rows are things you READ, not things you press. That is deliberate: a row
// you can press is a 6° target, and 6° rows at a comfortable reading distance
// buy you four of them on a whole panel. Reading rows are 1.4° of em box, which
// buys seventeen, and seventeen rows is what makes this a finding tool. Opening
// a card from here is a later card, and it gets a target the size of a target.
//
// Two things on it ARE targets: the search field, and the plate that closes it.

import * as THREE from 'three';
import * as W from './world.js';
import { root, Container, Text, Input, COL, cm, fontFor, inert, safe } from './kit.js';
import { Target } from './hover.js';

const PANEL = W.listPanel();
const D = PANEL.distM;

export class CardList {
  constructor() {
    this.open = false;
    this.query = '';
    this.doc = { cards: [] };
    this.group = new THREE.Group();
    this.group.position.set(PANEL.pos.x, PANEL.pos.y, PANEL.pos.z);
    this.group.lookAt(0, W.EYE, 0);
    this.group.visible = false;

    const pad = W.sizeForArc(1.0, D);
    const line = W.sizeForArc(W.TYPE.body * 1.35, D);
    this.line = line;

    this.ui = root({
      sizeX: PANEL.widthM, sizeY: PANEL.heightM,
      flexDirection: 'column', padding: cm(pad), gap: cm(pad * 0.6),
      backgroundColor: '#0d1117', backgroundOpacity: 0.97, borderRadius: cm(0.02),
    });
    this.group.add(this.ui);

    // The header: what this is, the search field, and the way out.
    const head = new Container({ flexDirection: 'row', alignItems: 'center', gap: cm(pad), height: cm(W.sizeForArc(W.BUILD.hit, D)) });
    this.ui.add(head);

    this.search = new Input({
      flexGrow: 1, height: '100%',
      backgroundColor: '#141d28', backgroundOpacity: 1, borderRadius: cm(0.012),
      paddingX: cm(pad * 0.6), verticalAlign: 'center',
      fontSize: fontFor(W.TYPE.body, D), color: COL.text, caretColor: COL.accent,
      placeholder: 'search every card',
      onValueChange: (v) => { this.query = v || ''; this.repaint(); },
    });
    head.add(this.search);

    const closeBox = new Container({
      width: cm(W.sizeForArc(W.BUILD.hit, D)), height: '100%',
      backgroundColor: '#1b2531', backgroundOpacity: 1, borderRadius: cm(0.012),
      justifyContent: 'center', alignItems: 'center',
    });
    const closeMark = new Text({ text: safe('×'), fontSize: fontFor(W.TYPE.head, D), color: COL.dim });
    inert(closeMark);
    closeBox.add(closeMark);
    head.add(closeBox);
    this.closeBox = closeBox;
    this.closeMark = closeMark;

    this.count = new Text({ text: '', fontSize: fontFor(W.TYPE.meta, D), color: COL.faint, height: cm(line) });
    inert(this.count);
    this.ui.add(this.count);

    // The rows. Nested scroll, so the long tail is a flick rather than a
    // paging control nobody can hit.
    this.rows = new Container({
      flexGrow: 1, flexDirection: 'column', overflow: 'scroll', gap: cm(line * 0.14),
      scrollbarWidth: cm(W.sizeForArc(0.35, D)), scrollbarColor: COL.faint,
      scrollbarBorderRadius: cm(0.004), scrollbarOpacity: 0.5,
    });
    this.ui.add(this.rows);
    this.pool = [];

    // The header controls are the only responsive regions on the panel, and
    // they are the hit floor at the distance the panel stands.
    const close = new Target({ mesh: closeBox, name: 'list-close', onSelect: () => this.setOpen(false) });
    // uikit paints its own hover and active out of the conditional properties
    // below, so this target keeps the six-state machine and the select-on-release
    // and hands the painting over rather than fighting it.
    close._paint = () => {};
    this.targets = [close];
    closeBox.setProperties({ hover: { backgroundColor: '#2a5f7a' }, active: { backgroundColor: '#4cc2ff' } });
    this.search.setProperties({ hover: { backgroundColor: '#1b2531' } });
  }

  setOpen(on) {
    this.open = on;
    this.group.visible = on;
    // `display`, not three's own `visible`: uikit derives whether a component
    // answers a ray from its OWN visibility, and a subtree hidden by an ancestor
    // Group is still, as far as uikit is concerned, standing there waiting to be
    // pointed at. While the list is up it owns the room's pointer anyway — the
    // panel stands nearer than the shelves and covers them, and two colliders
    // arguing over one ray is the mis-hit everything else here is built around.
    this.ui.setProperties({ display: on ? 'flex' : 'none' });
    if (on) this.repaint();
  }

  paint(doc) { this.doc = doc || { cards: [] }; if (this.open) this.repaint(); }

  repaint() {
    const q = this.query.trim().toLowerCase();
    const cards = (this.doc.cards || []).filter((c) => !q
      || String(c.title || '').toLowerCase().includes(q)
      || String(c.id || '').toLowerCase().includes(q)
      || (c.labels || []).join(' ').toLowerCase().includes(q));
    const cols = new Map(W.columnsOf(this.doc).map((c, i) => [c.id, { title: c.title || c.id, i }]));
    const lts = new Map((this.doc.lieutenants || []).map((l) => [l.id, l]));
    const total = (this.doc.cards || []).length;
    this.count.setProperties({ text: safe(q ? cards.length + ' of ' + total : total + ' cards') });

    const want = Math.min(cards.length, 60);
    while (this.pool.length < want) this.pool.push(this._row());
    this.pool.forEach((r, i) => {
      const c = cards[i];
      r.box.setProperties({ display: i < want ? 'flex' : 'none' });
      if (!c) { r.title.setProperties({ text: '' }); r.where.setProperties({ text: '' }); return; }
      const col = cols.get(c.column);
      const lt = lts.get(c.owner);
      const slot = this._where(c, col);
      r.chip.setProperties({ backgroundColor: W.agentColour(lt && lt.color) });
      r.title.setProperties({ text: safe(c.title || c.id) });
      r.where.setProperties({ text: safe(slot) });
    });
  }

  // Where the card is standing, said the way a person would look for it — which
  // is the whole job of a list in a room.
  _where(card, col) {
    const { visible } = W.shelfCards(this.doc, card.column);
    const at = visible.indexOf(card);
    const name = (col && col.title) || card.column || '';
    if (at < 0) return name + ' - not on a shelf';
    const row = Math.floor(at / W.SLOT.cols) + 1, c = (at % W.SLOT.cols) + 1;
    return name + ' r' + row + ' s' + c;
  }

  _row() {
    const box = new Container({
      flexDirection: 'row', alignItems: 'center', gap: cm(W.sizeForArc(0.6, D)),
      height: cm(this.line * 1.15), flexShrink: 0, overflow: 'hidden',
    });
    const chip = new Container({ width: cm(W.sizeForArc(0.5, D)), height: '70%', borderRadius: cm(0.004), backgroundColor: COL.faint });
    // The title gives way and the place does not: which shelf and which slot the
    // card is standing in is the answer this panel exists to give, and a title
    // clipped at the right is still the title.
    const title = new Text({
      text: '', flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: 'hidden',
      fontSize: fontFor(W.TYPE.body, D), color: COL.text, wordBreak: 'keep-all',
    });
    const where = new Text({
      text: '', width: '34%', flexShrink: 0, textAlign: 'right',
      fontSize: fontFor(W.TYPE.meta, D), color: COL.faint, wordBreak: 'keep-all',
    });
    box.add(chip, title, where);
    inert(box);
    this.rows.add(box);
    return { box, chip, title, where };
  }

  tick(now) { for (const t of this.targets) t.tick(now); }
}

// ---- the plate that summons it --------------------------------------------

// On the floor, in the lane between the two middle shelves, where nothing else
// lives. A control you glance down at rather than something you read — which is
// why it is allowed to sit below the band everything readable is held to.
export class ListPlate {
  constructor(onToggle) {
    const p = W.plate();
    this.at = p;
    this.group = new THREE.Group();
    this.group.position.set(p.pos.x, 0.002, p.pos.z);
    this.group.rotation.x = -Math.PI / 2;

    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(p.widthM, p.depthM),
      new THREE.MeshBasicMaterial({ color: COL.slot, transparent: true, opacity: 0.5 }),
    );
    this.group.add(face);

    const spot = new THREE.Mesh(
      new THREE.RingGeometry(p.widthM * 0.44, p.widthM * 0.5, 28),
      new THREE.MeshBasicMaterial({ color: '#7fd8ff', transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    spot.position.z = 0.001;
    spot.visible = false;
    this.group.add(spot);

    this.ui = root({
      sizeX: p.widthM, sizeY: p.depthM,
      justifyContent: 'center', alignItems: 'center', backgroundOpacity: 0,
    });
    inert(this.ui);
    this.ui.position.z = 0.002;
    this.group.add(this.ui);
    this.ui.add(new Text({
      text: 'the list', color: COL.dim, fontWeight: 'semi-bold',
      fontSize: fontFor(W.TYPE.body, p.dist),
    }));

    this.target = new Target({
      mesh: face, spot, name: 'list-plate',
      base: new THREE.Color(COL.slot), onSelect: onToggle,
    });
  }

  tick(now) { this.target.tick(now); }
}
