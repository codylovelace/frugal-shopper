// Turns a list pasted from a phone's notes app into item names.

import { nameKey } from './match.js';

export const MAX_ITEM_NAME = 100;
export const MAX_PASTED_ITEMS = 200;
export const MAX_QUANTITY = 99;

// Checkboxes, bullets and numbering that notes apps and markdown put in
// front of each line: "- [ ] Milk", "☐ Milk", "• Milk", "1. Milk", "2) Milk".
const MARKER_RE = /^(?:[-*+•◦▪▫‣⁃–—·]\s*)?(?:\[[ xX✓✔]?\]\s*|[☐☑☒✓✔✅⬜⬛◻◼□■○●◯]\s*)?(?:\d{1,3}[.)]\s+)?/u;

/** Clean one pasted line into an item name, or '' if nothing is left. */
export function cleanLine(line) {
  let text = String(line).replace(/\s+/g, ' ').trim();
  // Markers can stack, e.g. "- ☐ Milk"; strip until nothing more comes off.
  for (let i = 0; i < 3; i++) {
    const stripped = text.replace(MARKER_RE, '').trim();
    if (stripped === text) break;
    text = stripped;
  }
  return text.slice(0, MAX_ITEM_NAME).trim();
}

// "2x Milk", "2 x Milk", "2 × Milk": the name must not start with a digit, so
// "4 x 330ml Coke" stays a pack size rather than becoming four of "330ml Coke".
const LEADING_QTY_RE = /^(\d{1,2})\s*[x×]\s*(?=[^\d\s])(.+)$/iu;
// "Milk x2", "Milk ×2", "Milk x 2".
const TRAILING_QTY_RE = /^(.+?)\s+[x×]\s*(\d{1,2})$/iu;

/** Split "2x Milk" or "Milk x2" into { name, quantity }; otherwise quantity 1. */
export function splitQuantity(text) {
  const lead = LEADING_QTY_RE.exec(text);
  const trail = lead ? null : TRAILING_QTY_RE.exec(text);
  const [rawQty, name] = lead ? [lead[1], lead[2]] : trail ? [trail[2], trail[1]] : [null, text];
  const quantity = rawQty === null ? 1 : Number(rawQty);
  if (!(quantity >= 1 && quantity <= MAX_QUANTITY) || !name.trim()) return { name: text, quantity: 1 };
  return { name: name.trim(), quantity };
}

/**
 * Split pasted text into items: one per line, markers stripped, "2x" style
 * quantities picked out and blank lines dropped. A line repeating an earlier
 * one (same item, however it's written) adds its quantity to that one.
 * `existingNames` are the open items already on the list; lines matching them
 * are counted in `merging`, because adding them tops up the existing item.
 * Returns { items: [{ name, quantity }], combined, merging, truncated }.
 */
export function parsePastedList(text, existingNames = []) {
  const existing = new Set(existingNames.map(nameKey));
  const byKey = new Map();
  let combined = 0;
  for (const line of String(text ?? '').split(/\r\n|\r|\n|\u2028|\u2029/)) {
    const cleaned = cleanLine(line);
    if (!cleaned) continue;
    const item = splitQuantity(cleaned);
    const k = nameKey(item.name);
    if (!k) continue;
    const earlier = byKey.get(k);
    if (earlier) {
      earlier.quantity = Math.min(MAX_QUANTITY, earlier.quantity + item.quantity);
      combined += 1;
      continue;
    }
    byKey.set(k, item);
  }
  const all = [...byKey.values()];
  const items = all.slice(0, MAX_PASTED_ITEMS);
  const merging = items.filter((i) => existing.has(nameKey(i.name))).length;
  return { items, combined, merging, truncated: all.length > MAX_PASTED_ITEMS };
}
