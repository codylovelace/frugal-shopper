// Mirrors server/ops.js closely enough to show a change the moment it is made,
// before the server confirms it. The server's copy always wins once it arrives.

export function applyLocal(items, op, by) {
  const now = Date.now();
  const item = op.id ? items.get(op.id) : null;
  switch (op.kind) {
    case 'add': {
      if (item) return;
      const maxSort = Math.max(0, ...[...items.values()].map((i) => i.sort));
      items.set(op.id, {
        id: op.id,
        name: op.name,
        note: op.note || '',
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
    case 'clearBought':
      for (const id of op.ids) {
        if (items.get(id)?.bought) items.delete(id);
      }
      return;
  }
}
