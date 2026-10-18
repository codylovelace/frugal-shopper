// Validates and applies list operations sent by clients. Every change to the
// list goes through applyOp so the rules live in one place.

export class OpError extends Error {}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_PRICE_PENCE = 1_000_000; // £10,000 is plenty for a grocery line.

export const LIMITS = { name: 100, note: 200, size: 30 };

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
export function applyOp(list, config, op, by) {
  if (!op || typeof op !== 'object') throw new OpError('operation missing');
  if (!config.people.some((p) => p.name === by)) throw new OpError('choose who you are first');

  switch (op.kind) {
    case 'add': {
      const id = itemId(op.id);
      const name = text(op.name, 'name', { max: LIMITS.name, required: true });
      const note = text(op.note, 'note', { max: LIMITS.note });
      // A resent add for an item that already exists is a no-op.
      const already = list.getItem(id);
      if (already) return { items: [already], deleted: [] };
      return { items: [list.addItem({ id, name, note, by })], deleted: [] };
    }
    case 'edit': {
      const id = itemId(op.id);
      existing(list, id);
      const name = text(op.name, 'name', { max: LIMITS.name, required: true });
      const note = text(op.note, 'note', { max: LIMITS.note });
      return { items: [list.updateItem(id, { name, note })], deleted: [] };
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
    default:
      throw new OpError(`unknown operation: ${String(op.kind)}`);
  }
}
