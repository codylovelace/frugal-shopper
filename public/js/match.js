// Decides when two item names mean the same thing, so lists imported by
// different people can be combined. Shared by the browser and the server.

import { parseSize } from './compare.js';

// Plurals: "tomatoes" -> "tomato", "boxes" -> "box", "eggs" -> "egg".
function singular(word) {
  if (word.length <= 3 || /[0-9]/.test(word) || /ss$/.test(word)) return word;
  if (/(?:[sxz]|ch|sh|o)es$/.test(word)) return word.slice(0, -2);
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

// "500 g", "500g", "0.5kg" all become "500g"; "1 litre" and "1000ml" become "1000ml".
function normaliseSizes(text) {
  return text.replace(
    /(\d+(?:\.\d+)?)\s*(kg|kgs|kilos?|g|grams?|gr|ml|cl|l|ltr|litres?|liters?)\b/g,
    (whole, n, unit) => {
      const size = parseSize(`${n}${unit}`);
      if (!size) return whole;
      return size.dim === 'mass' ? `${size.base}g` : `${size.base}ml`;
    },
  );
}

/** Tokens of a name with case, punctuation, plurals and size spelling ironed out. */
export function nameTokens(name) {
  const text = normaliseSizes(
    String(name ?? '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}.\s]+/gu, ' ')
      .replace(/\.(?!\d)/g, ' '),
  );
  return text.split(/\s+/).filter(Boolean).map(singular);
}

/**
 * Key for "these are the same item": equal keys are merged without asking.
 * Word order is ignored, so "Beef mince 5%" and "5% beef mince" match.
 */
export function nameKey(name) {
  return [...new Set(nameTokens(name))].sort().join(' ');
}

const isSize = (token) => /^\d+(?:\.\d+)?(?:g|ml)$/.test(token);

// Words that describe the amount rather than the product ("4 pints", "loose").
const AMOUNT_WORDS = new Set([
  'pint',
  'pack',
  'pk',
  'bag',
  'box',
  'tin',
  'can',
  'bottle',
  'jar',
  'loose',
  'x',
]);

// The word naming what the product is. In shopping names that is the last
// one: "oat milk" is milk, "rolled oats" are oats.
function headWord(words) {
  for (let i = words.length - 1; i >= 0; i--) {
    if (!/^[\d.]+%?$/.test(words[i]) && !AMOUNT_WORDS.has(words[i])) return words[i];
  }
  return words[words.length - 1];
}

/**
 * True when two different names probably mean the same thing, e.g.
 * "500g oats" and "500g rolled oats". Used only to suggest a merge, never to
 * merge on its own, because "milk" and "oat milk" also look alike.
 */
export function looksLikeSameItem(a, b) {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size === 0 || tb.size === 0) return false;
  if (nameKey(a) === nameKey(b)) return false; // identical: merged anyway

  // Different pack sizes are different products.
  const sa = [...ta].filter(isSize);
  const sb = [...tb].filter(isSize);
  if (sa.length && sb.length && sa.sort().join() !== sb.sort().join()) return false;

  const words = (set) => [...set].filter((t) => !isSize(t));
  const wa = words(ta);
  const wb = words(tb);
  if (wa.length === 0 || wb.length === 0) return false;
  // "Oat milk" is not "oats": each name's head word must appear in the other.
  if (!wb.includes(headWord(wa)) || !wa.includes(headWord(wb))) return false;
  const shared = wa.filter((t) => wb.includes(t)).length;
  if (shared === 0) return false;
  const [small, large] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  // One name's words all appear in the other ("oats" in "rolled oats"),
  // or most of the words overlap.
  if (small.every((t) => large.includes(t))) return true;
  return shared / new Set([...wa, ...wb]).size >= 0.6;
}
