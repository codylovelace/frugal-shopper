import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Each entry upgrades the schema by one version. Never edit a shipped entry;
// append a new one so existing databases migrate forward.
export const MIGRATIONS = [
  `
  CREATE TABLE items (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    note               TEXT NOT NULL DEFAULT '',
    sort               INTEGER NOT NULL,
    created_at         INTEGER NOT NULL,
    created_by         TEXT NOT NULL,
    updated_at         INTEGER NOT NULL,
    bought_store       TEXT,
    bought_price_pence INTEGER,
    bought_by          TEXT,
    bought_at          INTEGER
  );
  CREATE TABLE quotes (
    item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    store       TEXT NOT NULL,
    price_pence INTEGER,
    size        TEXT NOT NULL DEFAULT '',
    updated_by  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (item_id, store)
  );
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Remembers client operation ids so a resent operation is not applied twice.
  CREATE TABLE applied_ops (
    op_id      TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );
  CREATE INDEX applied_ops_applied_at ON applied_ops(applied_at);
  `,
  // How many of an item to buy. Quoted prices are per pack; the bought price is the total paid.
  `ALTER TABLE items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;`,
  // Who needs each item and how many. An item needed by more than one person
  // shows under "Both need"; its quantity is the sum of everyone's needs.
  // Items that look alike but were kept apart remember it in merge_dismissals.
  `
  CREATE TABLE item_needs (
    item_id  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    person   TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 1),
    PRIMARY KEY (item_id, person)
  );
  INSERT INTO item_needs (item_id, person, quantity) SELECT id, created_by, quantity FROM items;
  ALTER TABLE items DROP COLUMN quantity;
  CREATE TABLE merge_dismissals (
    item_a TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    item_b TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (item_a, item_b)
  );
  `,
  // Finished shopping trips. Each keeps a copy of what was bought and every
  // shop's price for it, so you can look back at what was cheapest where.
  `
  CREATE TABLE trips (
    id          INTEGER PRIMARY KEY,
    finished_at INTEGER NOT NULL,
    finished_by TEXT NOT NULL
  );
  CREATE INDEX trips_finished_at ON trips(finished_at);
  CREATE TABLE trip_items (
    id                 INTEGER PRIMARY KEY,
    trip_id            INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    note               TEXT NOT NULL DEFAULT '',
    quantity           INTEGER NOT NULL,
    needs              TEXT NOT NULL DEFAULT '{}',
    bought_store       TEXT NOT NULL,
    bought_price_pence INTEGER NOT NULL,
    bought_by          TEXT NOT NULL,
    bought_at          INTEGER NOT NULL
  );
  CREATE INDEX trip_items_trip ON trip_items(trip_id);
  CREATE INDEX trip_items_name ON trip_items(name COLLATE NOCASE);
  CREATE TABLE trip_quotes (
    trip_item_id INTEGER NOT NULL REFERENCES trip_items(id) ON DELETE CASCADE,
    store        TEXT NOT NULL,
    price_pence  INTEGER,
    size         TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (trip_item_id, store)
  );
  `,
];

const OP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

function rowToItem(row, quoteRows, needRows = [], dismissed = []) {
  const quotes = {};
  for (const q of quoteRows) {
    quotes[q.store] = {
      pricePence: q.price_pence,
      size: q.size,
      updatedBy: q.updated_by,
      updatedAt: q.updated_at,
    };
  }
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    needs: Object.fromEntries(needRows.map((n) => [n.person, n.quantity])),
    quantity: needRows.reduce((sum, n) => sum + n.quantity, 0),
    keepSeparate: dismissed,
    sort: row.sort,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    quotes,
    bought:
      row.bought_store === null
        ? null
        : {
            store: row.bought_store,
            pricePence: row.bought_price_pence,
            by: row.bought_by,
            at: row.bought_at,
          },
  };
}

export class ListStore {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
    this.stmt = {
      allItems: db.prepare('SELECT * FROM items ORDER BY sort, created_at'),
      allQuotes: db.prepare('SELECT * FROM quotes'),
      item: db.prepare('SELECT * FROM items WHERE id = ?'),
      itemQuotes: db.prepare('SELECT * FROM quotes WHERE item_id = ?'),
      nextSort: db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM items'),
      insertItem: db.prepare(
        `INSERT INTO items (id, name, note, sort, created_at, created_by, updated_at)
         VALUES (@id, @name, @note, @sort, @now, @by, @now)`,
      ),
      allNeeds: db.prepare('SELECT * FROM item_needs ORDER BY rowid'),
      itemNeeds: db.prepare('SELECT * FROM item_needs WHERE item_id = ? ORDER BY rowid'),
      setNeed: db.prepare(
        `INSERT INTO item_needs (item_id, person, quantity) VALUES (?, ?, ?)
         ON CONFLICT (item_id, person) DO UPDATE SET quantity = excluded.quantity`,
      ),
      deleteNeed: db.prepare('DELETE FROM item_needs WHERE item_id = ? AND person = ?'),
      allDismissals: db.prepare('SELECT * FROM merge_dismissals'),
      itemDismissals: db.prepare('SELECT * FROM merge_dismissals WHERE item_a = ? OR item_b = ?'),
      dismiss: db.prepare('INSERT OR IGNORE INTO merge_dismissals (item_a, item_b) VALUES (?, ?)'),
      updateItem: db.prepare('UPDATE items SET name = @name, note = @note, updated_at = @now WHERE id = @id'),
      touch: db.prepare('UPDATE items SET updated_at = ? WHERE id = ?'),
      upsertQuote: db.prepare(
        `INSERT INTO quotes (item_id, store, price_pence, size, updated_by, updated_at)
         VALUES (@id, @store, @pricePence, @size, @by, @now)
         ON CONFLICT (item_id, store) DO UPDATE SET
           price_pence = excluded.price_pence,
           size = excluded.size,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      ),
      deleteQuote: db.prepare('DELETE FROM quotes WHERE item_id = ? AND store = ?'),
      markBought: db.prepare(
        `UPDATE items SET bought_store = @store, bought_price_pence = @pricePence,
           bought_by = @by, bought_at = @now, updated_at = @now WHERE id = @id`,
      ),
      unmarkBought: db.prepare(
        `UPDATE items SET bought_store = NULL, bought_price_pence = NULL,
           bought_by = NULL, bought_at = NULL, updated_at = ? WHERE id = ?`,
      ),
      deleteItem: db.prepare('DELETE FROM items WHERE id = ?'),
      deleteBought: db.prepare('DELETE FROM items WHERE id = ? AND bought_store IS NOT NULL'),
      opSeen: db.prepare('SELECT 1 FROM applied_ops WHERE op_id = ?'),
      recordOp: db.prepare('INSERT OR IGNORE INTO applied_ops (op_id, applied_at) VALUES (?, ?)'),
      pruneOps: db.prepare('DELETE FROM applied_ops WHERE applied_at < ?'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ),
    };
  }

  /** Run fn inside a single SQLite transaction. */
  transaction(fn) {
    return this.db.transaction(fn)();
  }

  listItems() {
    const group = (rows, key) => {
      const map = new Map();
      for (const r of rows) {
        if (!map.has(r[key])) map.set(r[key], []);
        map.get(r[key]).push(r);
      }
      return map;
    };
    const quotes = group(this.stmt.allQuotes.all(), 'item_id');
    const needs = group(this.stmt.allNeeds.all(), 'item_id');
    const dismissed = new Map();
    for (const d of this.stmt.allDismissals.all()) {
      if (!dismissed.has(d.item_a)) dismissed.set(d.item_a, []);
      if (!dismissed.has(d.item_b)) dismissed.set(d.item_b, []);
      dismissed.get(d.item_a).push(d.item_b);
      dismissed.get(d.item_b).push(d.item_a);
    }
    return this.stmt.allItems
      .all()
      .map((row) =>
        rowToItem(row, quotes.get(row.id) || [], needs.get(row.id) || [], dismissed.get(row.id) || []),
      );
  }

  getItem(id) {
    const row = this.stmt.item.get(id);
    if (!row) return null;
    const dismissed = this.stmt.itemDismissals
      .all(id, id)
      .map((d) => (d.item_a === id ? d.item_b : d.item_a));
    return rowToItem(row, this.stmt.itemQuotes.all(id), this.stmt.itemNeeds.all(id), dismissed);
  }

  /** needs: { [person]: quantity } with at least one entry. */
  addItem({ id, name, note, needs, by }) {
    const sort = this.stmt.nextSort.get().next;
    this.stmt.insertItem.run({ id, name, note, sort, by, now: this.now() });
    for (const [person, quantity] of Object.entries(needs)) this.stmt.setNeed.run(id, person, quantity);
    return this.getItem(id);
  }

  /** Set how many `person` needs; 0 removes them from the item. */
  setNeed(id, person, quantity) {
    if (quantity > 0) this.stmt.setNeed.run(id, person, quantity);
    else this.stmt.deleteNeed.run(id, person);
    this.stmt.touch.run(this.now(), id);
    return this.getItem(id);
  }

  /**
   * Fold item `fromId` into `intoId`: needs are added together, prices the
   * target lacks are copied over, and `fromId` is deleted.
   */
  mergeItems(fromId, intoId) {
    const from = this.getItem(fromId);
    const into = this.getItem(intoId);
    for (const [person, quantity] of Object.entries(from.needs)) {
      this.stmt.setNeed.run(intoId, person, (into.needs[person] || 0) + quantity);
    }
    const now = this.now();
    for (const [store, q] of Object.entries(from.quotes)) {
      if (into.quotes[store]) continue;
      this.stmt.upsertQuote.run({
        id: intoId,
        store,
        pricePence: q.pricePence,
        size: q.size,
        by: q.updatedBy,
        now,
      });
    }
    if (from.note && !into.note)
      this.stmt.updateItem.run({ id: intoId, name: into.name, note: from.note, now });
    this.stmt.deleteItem.run(fromId);
    this.stmt.touch.run(now, intoId);
    return this.getItem(intoId);
  }

  /** Remember that two look-alike items are different, so the merge suggestion stops. */
  keepSeparate(a, b) {
    const [x, y] = a < b ? [a, b] : [b, a];
    this.stmt.dismiss.run(x, y);
  }

  updateItem(id, { name, note }) {
    this.stmt.updateItem.run({ id, name, note, now: this.now() });
    return this.getItem(id);
  }

  setQuote(id, store, { pricePence, size }, by) {
    const now = this.now();
    if (pricePence === null && size === '') {
      this.stmt.deleteQuote.run(id, store);
    } else {
      this.stmt.upsertQuote.run({ id, store, pricePence, size, by, now });
    }
    this.stmt.touch.run(now, id);
    return this.getItem(id);
  }

  markBought(id, { store, pricePence }, by) {
    this.stmt.markBought.run({ id, store, pricePence, by, now: this.now() });
    return this.getItem(id);
  }

  unmarkBought(id) {
    this.stmt.unmarkBought.run(this.now(), id);
    return this.getItem(id);
  }

  deleteItem(id) {
    return this.stmt.deleteItem.run(id).changes > 0;
  }

  /** Delete the given items that are still ticked off; returns the ids removed. */
  clearBought(ids) {
    const removed = [];
    for (const id of ids) {
      if (this.stmt.deleteBought.run(id).changes > 0) removed.push(id);
    }
    return removed;
  }

  hasAppliedOp(opId) {
    return Boolean(this.stmt.opSeen.get(opId));
  }

  recordOp(opId) {
    this.stmt.recordOp.run(opId, this.now());
  }

  pruneOps() {
    return this.stmt.pruneOps.run(this.now() - OP_RETENTION_MS).changes;
  }

  getMeta(key) {
    const row = this.stmt.getMeta.get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.stmt.setMeta.run(key, value);
  }

  ping() {
    return this.db.prepare('SELECT 1 AS ok').get().ok === 1;
  }
}
