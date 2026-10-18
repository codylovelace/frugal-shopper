// Mirrors server/ops.js closely enough to show a change the moment it is made,
// before the server confirms it. The server's copy always wins once it arrives.

import { nameKey } from './match.js';

const total = (needs) => Object.values(needs).reduce((sum, n) => sum + n, 0);

function setNeed(item, person, quantity) {
  const needs = { ...item.needs };
  if (quantity > 0) needs[person] = quantity;
  else delete needs[person];
  Object.assign(item, { needs, quantity: total(needs) });
}

export function applyLocal(items, op, by) {
  const now = Date.now();
  const item = op.id ? items.get(op.id) : null;
  switch (op.kind) {
    case 'add': {
      if (item) return;
      const forPerson = op.for || by;
      const qty = op.quantity || 1;
      const key = nameKey(op.name);
      const match = [...items.values()].find((i) => !i.bought && nameKey(i.name) === key);
      if (match) {
        setNeed(match, forPerson, (match.needs[forPerson] || 0) + qty);
        return;
      }
      const maxSort = Math.max(0, ...[...items.values()].map((i) => i.sort));
      items.set(op.id, {
        id: op.id,
        name: op.name,
        note: op.note || '',
        needs: { [forPerson]: qty },
        quantity: qty,
        keepSeparate: [],
        sort: maxSort + 1,
        createdAt: now,
        createdBy: by,
        updatedAt: now,
        quotes: {},
        bought: null,
      });
      return;
    }
    case 'edit':
      if (item) Object.assign(item, { name: op.name, note: op.note || '', updatedAt: now });
      return;
    case 'quantity':
      if (item) setNeed(item, op.person || by, op.quantity);
      return;
    case 'merge': {
      const into = items.get(op.intoId);
      if (!item || !into) return;
      const needs = { ...into.needs };
      for (const [p, n] of Object.entries(item.needs)) needs[p] = (needs[p] || 0) + n;
      Object.assign(into, { needs, quantity: total(needs), quotes: { ...item.quotes, ...into.quotes } });
      items.delete(op.id);
      return;
    }
    case 'keepSeparate': {
      const other = items.get(op.otherId);
      if (item && other) {
        item.keepSeparate = [...item.keepSeparate, op.otherId];
        other.keepSeparate = [...other.keepSeparate, op.id];
      }
      return;
    }
    case 'quote':
      if (!item) return;
      if (op.pricePence === null && !op.size) delete item.quotes[op.store];
      else
        item.quotes[op.store] = {
          pricePence: op.pricePence,
          size: op.size || '',
          updatedBy: by,
          updatedAt: now,
        };
      return;
    case 'buy':
      if (item) item.bought = { store: op.store, pricePence: op.pricePence, by, at: now };
      return;
    case 'unbuy':
      if (item) item.bought = null;
      return;
    case 'delete':
      items.delete(op.id);
      return;
    case 'finishTrip':
    case 'clearBought':
      for (const id of op.ids) {
        if (items.get(id)?.bought) items.delete(id);
      }
      return;
  }
}
