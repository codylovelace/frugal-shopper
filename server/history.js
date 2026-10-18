// Past shopping trips: written when someone presses "Finish this shop", then
// read-only apart from deleting a whole trip.

import { nameKey } from '../public/js/match.js';

export class HistoryStore {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
    this.stmt = {
      insertTrip: db.prepare('INSERT INTO trips (finished_at, finished_by) VALUES (?, ?)'),
      insertItem: db.prepare(
        `INSERT INTO trip_items
           (trip_id, name, note, quantity, needs, bought_store, bought_price_pence, bought_by, bought_at)
         VALUES (@tripId, @name, @note, @quantity, @needs, @store, @pricePence, @by, @at)`,
      ),
      insertQuote: db.prepare(
        'INSERT INTO trip_quotes (trip_item_id, store, price_pence, size) VALUES (?, ?, ?, ?)',
      ),
      trips: db.prepare(
        `SELECT t.id, t.finished_at, t.finished_by, COUNT(i.id) AS item_count
           FROM trips t LEFT JOIN trip_items i ON i.trip_id = t.id
          GROUP BY t.id ORDER BY t.finished_at DESC LIMIT ?`,
      ),
      trip: db.prepare('SELECT * FROM trips WHERE id = ?'),
      tripItems: db.prepare('SELECT * FROM trip_items WHERE trip_id = ? ORDER BY bought_at, id'),
      tripQuotes: db.prepare(
        `SELECT q.* FROM trip_quotes q JOIN trip_items i ON i.id = q.trip_item_id WHERE i.trip_id = ?`,
      ),
      deleteTrip: db.prepare('DELETE FROM trips WHERE id = ?'),
      allItemsNewestFirst: db.prepare(
        `SELECT i.*, t.finished_at FROM trip_items i JOIN trips t ON t.id = i.trip_id
          ORDER BY t.finished_at DESC, i.id DESC`,
      ),
      quotesFor: db.prepare('SELECT * FROM trip_quotes WHERE trip_item_id = ?'),
    };
  }

  /**
   * Save the given bought items (as returned by ListStore.getItem) as one trip.
   * The caller removes them from the live list in the same transaction.
   */
  recordTrip(items, by) {
    const tripId = Number(this.stmt.insertTrip.run(this.now(), by).lastInsertRowid);
    for (const item of items) {
      const tripItemId = Number(
        this.stmt.insertItem.run({
          tripId,
          name: item.name,
          note: item.note,
          quantity: item.quantity,
          needs: JSON.stringify(item.needs),
          store: item.bought.store,
          pricePence: item.bought.pricePence,
          by: item.bought.by,
          at: item.bought.at,
        }).lastInsertRowid,
      );
      for (const [store, q] of Object.entries(item.quotes)) {
        this.stmt.insertQuote.run(tripItemId, store, q.pricePence, q.size);
      }
    }
    return tripId;
  }

  /** Newest first, with per-shop spend so the list view needs no second call. */
  listTrips(limit = 200) {
    return this.stmt.trips.all(limit).map((t) => {
      const items = this.stmt.tripItems.all(t.id);
      const spent = {};
      for (const i of items) spent[i.bought_store] = (spent[i.bought_store] || 0) + i.bought_price_pence;
      return {
        id: t.id,
        finishedAt: t.finished_at,
        finishedBy: t.finished_by,
        itemCount: t.item_count,
        spent,
      };
    });
  }

  getTrip(id) {
    const trip = this.stmt.trip.get(id);
    if (!trip) return null;
    const quotes = groupQuotes(this.stmt.tripQuotes.all(id));
    return {
      id: trip.id,
      finishedAt: trip.finished_at,
      finishedBy: trip.finished_by,
      items: this.stmt.tripItems.all(id).map((row) => toItem(row, quotes.get(row.id))),
    };
  }

  deleteTrip(id) {
    return this.stmt.deleteTrip.run(id).changes > 0;
  }

  // Names are matched with the same rules that merge items on the list
  // (nameKey), so "Oats" and "oat" share a history. A household's history is a few thousand rows at most, so this scans it.

  /** Every past purchase of the same item as `name`, newest first. */
  itemHistory(name, limit = 100) {
    const key = nameKey(name);
    return this.stmt.allItemsNewestFirst
      .all()
      .filter((row) => nameKey(row.name) === key)
      .slice(0, limit)
      .map((row) => this.withQuotes(row));
  }

  /** The most recent past purchase of each item, keyed by nameKey. */
  lastSeen() {
    const out = {};
    for (const row of this.stmt.allItemsNewestFirst.all()) {
      const key = nameKey(row.name);
      if (!(key in out)) out[key] = this.withQuotes(row);
    }
    return out;
  }

  withQuotes(row) {
    return {
      ...toItem(row, groupQuotes(this.stmt.quotesFor.all(row.id)).get(row.id)),
      finishedAt: row.finished_at,
      tripId: row.trip_id,
    };
  }
}

function parseNeeds(text) {
  try {
    const needs = JSON.parse(text);
    return needs && typeof needs === 'object' ? needs : {};
  } catch {
    return {};
  }
}

function groupQuotes(rows) {
  const map = new Map();
  for (const q of rows) {
    if (!map.has(q.trip_item_id)) map.set(q.trip_item_id, {});
    map.get(q.trip_item_id)[q.store] = { pricePence: q.price_pence, size: q.size };
  }
  return map;
}

function toItem(row, quotes = {}) {
  return {
    name: row.name,
    note: row.note,
    quantity: row.quantity,
    needs: parseNeeds(row.needs),
    quotes,
    bought: {
      store: row.bought_store,
      pricePence: row.bought_price_pence,
      by: row.bought_by,
      at: row.bought_at,
    },
  };
}
