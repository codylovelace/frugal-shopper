// Turns a list pasted from a phone's notes app into item names.

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

const key = (name) => name.toLowerCase();

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
 * quantities picked out, blank lines dropped, and duplicates removed both
 * within the paste and against `existingNames` (items already on the list).
 * Returns { items: [{ name, quantity }], skipped, truncated } where skipped
 * counts duplicates left out and truncated says the paste was over the limit.
 */
export function parsePastedList(text, existingNames = []) {
  const seen = new Set(existingNames.map(key));
  const items = [];
  let skipped = 0;
  for (const line of String(text ?? '').split(/\r\n|\r|\n|\u2028|\u2029/)) {
    const cleaned = cleanLine(line);
    if (!cleaned) continue;
    const item = splitQuantity(cleaned);
    if (seen.has(key(item.name))) {
      skipped += 1;
      continue;
    }
    seen.add(key(item.name));
    items.push(item);
  }
  return { items: items.slice(0, MAX_PASTED_ITEMS), skipped, truncated: items.length > MAX_PASTED_ITEMS };
}
