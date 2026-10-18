// Price and pack-size helpers shared by the browser and the server.
// Everything money-related is integer pence to avoid floating point drift.

const MONEY_RE = /^\s*£?\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/;
const PENCE_RE = /^\s*(\d{1,7})\s*p\s*$/i;

/**
 * Parse user-entered money ("7.25", "£7.25", "7", "89p") into integer pence.
 * Returns null for empty input and NaN for anything unparseable.
 */
export function parsePence(input) {
  if (input === null || input === undefined) return null;
  const text = String(input).trim();
  if (text === '') return null;
  const pence = PENCE_RE.exec(text);
  if (pence) return Number(pence[1]);
  const m = MONEY_RE.exec(text);
  if (!m) return NaN;
  const pounds = Number(m[1]);
  const fraction = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return pounds * 100 + fraction;
}

export function formatPence(pence) {
  if (pence === null || pence === undefined || Number.isNaN(pence)) return '';
  const sign = pence < 0 ? '-' : '';
  const abs = Math.abs(Math.round(pence));
  return `${sign}£${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// Multipliers into a base unit per dimension: grams, millilitres, items.
const UNITS = {
  g: ['mass', 1],
  gram: ['mass', 1],
  grams: ['mass', 1],
  gr: ['mass', 1],
  kg: ['mass', 1000],
  kgs: ['mass', 1000],
  kilo: ['mass', 1000],
  kilos: ['mass', 1000],
  ml: ['volume', 1],
  cl: ['volume', 10],
  l: ['volume', 1000],
  ltr: ['volume', 1000],
  litre: ['volume', 1000],
  litres: ['volume', 1000],
  liter: ['volume', 1000],
  liters: ['volume', 1000],
  '': ['count', 1],
  each: ['count', 1],
  ea: ['count', 1],
  x: ['count', 1],
  pk: ['count', 1],
  pack: ['count', 1],
  pcs: ['count', 1],
  pc: ['count', 1],
  pieces: ['count', 1],
  rolls: ['count', 1],
  roll: ['count', 1],
};

const SIZE_RE = /^\s*(?:(\d+(?:\.\d+)?)\s*[x×*]\s*)?(\d+(?:\.\d+)?)\s*([a-z]*)\.?\s*$/i;

/**
 * Parse a pack size such as "750g", "1.5 kg", "4 x 330ml", "6 pack" or "12".
 * Returns { dim, base } where base is grams, millilitres or a count,
 * or null when the text is empty or not understood.
 */
export function parseSize(input) {
  if (input === null || input === undefined) return null;
  const m = SIZE_RE.exec(String(input));
  if (!m) return null;
  const unit = UNITS[m[3].toLowerCase()];
  if (!unit) return null;
  const multiplier = m[1] ? Number(m[1]) : 1;
  const base = multiplier * Number(m[2]) * unit[1];
  if (!(base > 0)) return null;
  return { dim: unit[0], base };
}

/** Human readable unit price, e.g. "£9.67/kg", "£1.20/l", "£0.50 each". */
export function formatUnitPrice(pricePence, size) {
  const parsed = typeof size === 'string' ? parseSize(size) : size;
  if (pricePence === null || pricePence === undefined || !parsed) return '';
  if (parsed.dim === 'mass') return `${formatPence((pricePence / parsed.base) * 1000)}/kg`;
  if (parsed.dim === 'volume') return `${formatPence((pricePence / parsed.base) * 1000)}/l`;
  if (parsed.base === 1) return '';
  return `${formatPence(pricePence / parsed.base)} each`;
}

const normaliseSizeText = (s) => (s ?? '').toString().trim().toLowerCase().replace(/\s+/g, '');

/**
 * Work out which store is cheapest for one item.
 *
 * quotes: { [store]: { pricePence, size } }
 * Returns {
 *   cheapest: string[]   stores tied for cheapest (empty if fewer than 2 prices),
 *   basis: 'unit' | 'price' | null,
 *   comparable: boolean  false when pack sizes differ in a way we cannot normalise,
 *   perBase: { [store]: pence per gram/ml/item } when basis is 'unit'
 * }
 */
export function compareQuotes(quotes) {
  const priced = Object.entries(quotes || {}).filter(([, q]) => q && Number.isInteger(q.pricePence));
  const result = { cheapest: [], basis: null, comparable: true, perBase: {} };
  if (priced.length < 2) return result;

  const parsed = priced.map(([store, q]) => [store, q, parseSize(q.size)]);
  const allParsed = parsed.every(([, , p]) => p);
  const sameDim = allParsed && parsed.every(([, , p]) => p.dim === parsed[0][2].dim);

  let scores;
  if (sameDim) {
    result.basis = 'unit';
    scores = parsed.map(([store, q, p]) => {
      result.perBase[store] = q.pricePence / p.base;
      return [store, q.pricePence / p.base];
    });
  } else {
    result.basis = 'price';
    const sizes = new Set(priced.map(([, q]) => normaliseSizeText(q.size)));
    // Sizes that are all blank or all written identically compare fine on price.
    result.comparable = sizes.size === 1;
    scores = priced.map(([store, q]) => [store, q.pricePence]);
  }

  const best = Math.min(...scores.map(([, s]) => s));
  // Tolerate sub-penny float noise from unit division.
  result.cheapest = scores.filter(([, s]) => s - best < 1e-9).map(([store]) => store);
  return result;
}

/**
 * How much was saved by buying `item` where it was bought, compared with the
 * cheapest other quote for the same quantity. Null when it can't be worked out.
 */
export function savingPence(item) {
  const bought = item.bought;
  if (!bought || !Number.isInteger(bought.pricePence)) return null;
  const quotes = item.quotes || {};
  const others = Object.entries(quotes).filter(
    ([store, q]) => store !== bought.store && q && Number.isInteger(q.pricePence),
  );
  if (others.length === 0) return null;

  const own = quotes[bought.store];
  // Without a quote from the store it was bought at we don't know the pack size.
  if (!own || !Number.isInteger(own.pricePence)) return null;
  const cmp = compareQuotes(quotes);
  const ownSize = parseSize(own.size);
  if (cmp.basis === 'unit' && ownSize) {
    const alt = Math.min(...others.map(([store]) => cmp.perBase[store] * ownSize.base));
    return Math.round(alt - bought.pricePence);
  }
  if (!cmp.comparable) return null;
  const alt = Math.min(...others.map(([, q]) => q.pricePence));
  return alt - bought.pricePence;
}
