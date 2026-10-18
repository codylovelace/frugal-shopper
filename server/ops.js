// Validates and applies list operations sent by clients. Every change to the
// list goes through applyOp so the rules live in one place.

import { nameKey } from '../public/js/match.js';

export class OpError extends Error {}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_PRICE_PENCE = 1_000_000; // £10,000 is plenty for a grocery line.

export const LIMITS = { name: 100, note: 200, size: 30, quantity: 99 };

function text(value, field, { max, required = false }) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new OpError(`${field} must be text`);
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (required && trimmed === '') throw new OpError(`${field} is required`);
  if (trimmed.length > max) throw new OpError(`${field} must be ${max} characters or fewer`);
  return trimmed;
}

function price(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new OpError(`${field} is required`);
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_PRICE_PENCE) {
    throw new OpError(`${field} must be a whole number of pence between 0 and ${MAX_PRICE_PENCE}`);
  }
  return value;
}

function quantity(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new OpError('quantity is required');
    return 1;
  }
  if (!Number.isInteger(value) || value < 1 || value > LIMITS.quantity) {
    throw new OpError(`quantity must be a whole number from 1 to ${LIMITS.quantity}`);
  }
  return value;
}

function person(value, config, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!config.people.some((p) => p.name === value)) throw new OpError(`unknown person: ${String(value)}`);
  return value;
}

function itemId(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new OpError('invalid item id');
  return value;
}

function store(value, stores) {
  if (!stores.includes(value)) throw new OpError(`unknown store: ${String(value)}`);
  return value;
}

function existing(list, id) {
  const item = list.getItem(id);
  if (!item) throw new OpError('item no longer exists');
  return item;
}

/**
 * Apply one operation. Returns { items: [changed items], deleted: [ids] }.
 * Throws OpError for invalid input; the caller reports it to the sender.
 */
export function applyOp(list, config, op, by, history = null) {
  if (!op || typeof op !== 'object') throw new OpError('operation missing');
  if (!config.people.some((p) => p.name === by)) throw new OpError('choose who you are first');

  switch (op.kind) {
    case 'add': {
      const id = itemId(op.id);
      const name = text(op.name, 'name', { max: LIMITS.name, required: true });
      const note = text(op.note, 'note', { max: LIMITS.note });
      const qty = quantity(op.quantity);
      const forPerson = person(op.for, config, by);
      // A resent add for an item that already exists is a no-op.
      const already = list.getItem(id);
      if (already) return { items: [already], deleted: [] };
      // The same thing already on the list (and not yet bought) gets this
      // person's quantity added to it instead of a second line, which is how
      // two imported lists combine into "Both need".
      const key = nameKey(name);
      const match = list.listItems().find((i) => !i.bought && nameKey(i.name) === key);
      if (match) {
        const merged = list.setNeed(match.id, forPerson, (match.needs[forPerson] || 0) + qty);
        return { items: [merged], deleted: [], mergedInto: match.id };
      }
      return { items: [list.addItem({ id, name, note, needs: { [forPerson]: qty }, by })], deleted: [] };
    }
    case 'edit': {
      const id = itemId(op.id);
      existing(list, id);
      const name = text(op.name, 'name', { max: LIMITS.name, required: true });
      const note = text(op.note, 'note', { max: LIMITS.note });
      return { items: [list.updateItem(id, { name, note })], deleted: [] };
    }
    case 'quantity': {
      // Sets one person's share; 0 takes them off an item someone else still needs.
      const id = itemId(op.id);
      const item = existing(list, id);
      const who = person(op.person, config, by);
      const qty = op.quantity === 0 ? 0 : quantity(op.quantity, { required: true });
      const othersNeed = Object.entries(item.needs).some(([p, n]) => p !== who && n > 0);
      if (qty === 0 && !othersNeed) throw new OpError('nobody else needs this; delete the item instead');
      return { items: [list.setNeed(id, who, qty)], deleted: [] };
    }
    case 'merge': {
      const id = itemId(op.id);
      const intoId = itemId(op.intoId);
      if (id === intoId) throw new OpError('cannot merge an item into itself');
      const from = existing(list, id);
      const into = existing(list, intoId);
      if (from.bought || into.bought) throw new OpError('untick items before merging them');
      return { items: [list.mergeItems(id, intoId)], deleted: [id] };
    }
    case 'keepSeparate': {
      const id = itemId(op.id);
      const otherId = itemId(op.otherId);
      if (id === otherId) throw new OpError('cannot compare an item with itself');
      existing(list, id);
      existing(list, otherId);
      list.keepSeparate(id, otherId);
      return { items: [list.getItem(id), list.getItem(otherId)], deleted: [] };
    }
    case 'quote': {
      const id = itemId(op.id);
      existing(list, id);
      const s = store(op.store, config.stores);
      const pricePence = price(op.pricePence, 'price');
      const size = text(op.size, 'size', { max: LIMITS.size });
      return { items: [list.setQuote(id, s, { pricePence, size }, by)], deleted: [] };
    }
    case 'buy': {
      const id = itemId(op.id);
      existing(list, id);
      const s = store(op.store, config.stores);
      const pricePence = price(op.pricePence, 'price paid', { required: true });
      return { items: [list.markBought(id, { store: s, pricePence }, by)], deleted: [] };
    }
    case 'unbuy': {
      const id = itemId(op.id);
      existing(list, id);
      return { items: [list.unmarkBought(id)], deleted: [] };
    }
    case 'delete': {
      const id = itemId(op.id);
      // Deleting something already gone is fine; the outcome is the same.
      list.deleteItem(id);
      return { items: [], deleted: [id] };
    }
    case 'clearBought': {
      // The client names the ticked items it could see, so a delayed resend
      // never removes something ticked off after the user pressed the button.
      if (!Array.isArray(op.ids) || op.ids.length > 1000) throw new OpError('ids must be a list');
      const ids = op.ids.map(itemId);
      return { items: [], deleted: list.clearBought(ids) };
    }
    case 'finishTrip': {
      // Saves the ticked items the phone could see as one dated trip and
      // takes them off the list. Unticked items stay for next time.
      if (!history) throw new OpError('history is not available');
      if (!Array.isArray(op.ids) || op.ids.length > 1000) throw new OpError('ids must be a list');
      const bought = op.ids
        .map(itemId)
        .map((id) => list.getItem(id))
        .filter((item) => item && item.bought);
      if (bought.length === 0) throw new OpError('nothing ticked off to save');
      const tripId = history.recordTrip(bought, by);
      for (const item of bought) list.deleteItem(item.id);
      return { items: [], deleted: bought.map((i) => i.id), historyChanged: true, tripId };
    }
    case 'deleteTrip': {
      if (!history) throw new OpError('history is not available');
      if (!Number.isInteger(op.tripId) || op.tripId < 1) throw new OpError('invalid trip');
      history.deleteTrip(op.tripId);
      return { items: [], deleted: [], historyChanged: true };
    }
    default:
      throw new OpError(`unknown operation: ${String(op.kind)}`);
  }
}
