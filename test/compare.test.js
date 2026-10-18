import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePence,
  formatPence,
  parseSize,
  formatUnitPrice,
  compareQuotes,
  savingPence,
} from '../public/js/compare.js';

test('parsePence handles the ways people type prices', () => {
  assert.equal(parsePence('7.25'), 725);
  assert.equal(parsePence('£7.25'), 725);
  assert.equal(parsePence(' £ 7.5 '), 750);
  assert.equal(parsePence('7'), 700);
  assert.equal(parsePence('0.89'), 89);
  assert.equal(parsePence('89p'), 89);
  assert.equal(parsePence(''), null);
  assert.equal(parsePence(null), null);
  assert.ok(Number.isNaN(parsePence('abc')));
  assert.ok(Number.isNaN(parsePence('7.255')));
  assert.ok(Number.isNaN(parsePence('-1')));
});

test('parsePence avoids floating point rounding errors', () => {
  // 0.29 * 100 is 28.999999999999996 in floating point.
  assert.equal(parsePence('0.29'), 29);
  assert.equal(parsePence('1.15'), 115);
});

test('formatPence', () => {
  assert.equal(formatPence(725), '£7.25');
  assert.equal(formatPence(5), '£0.05');
  assert.equal(formatPence(-34), '-£0.34');
  assert.equal(formatPence(null), '');
});

test('parseSize understands common pack sizes', () => {
  assert.deepEqual(parseSize('750g'), { dim: 'mass', base: 750 });
  assert.deepEqual(parseSize('1.5 kg'), { dim: 'mass', base: 1500 });
  assert.deepEqual(parseSize('4 x 330ml'), { dim: 'volume', base: 1320 });
  assert.deepEqual(parseSize('4x330ml'), { dim: 'volume', base: 1320 });
  assert.deepEqual(parseSize('2L'), { dim: 'volume', base: 2000 });
  assert.deepEqual(parseSize('70cl'), { dim: 'volume', base: 700 });
  assert.deepEqual(parseSize('6'), { dim: 'count', base: 6 });
  assert.deepEqual(parseSize('6 pack'), { dim: 'count', base: 6 });
  assert.equal(parseSize(''), null);
  assert.equal(parseSize('large'), null);
  assert.equal(parseSize('0g'), null);
});

test('formatUnitPrice', () => {
  assert.equal(formatUnitPrice(725, '750g'), '£9.67/kg');
  assert.equal(formatUnitPrice(120, '1l'), '£1.20/l');
  assert.equal(formatUnitPrice(300, '6'), '£0.50 each');
  assert.equal(formatUnitPrice(300, '1'), '');
  assert.equal(formatUnitPrice(300, ''), '');
});

test('the example from the brief: M&S £7.25 beats Aldi £7.59 for 750g', () => {
  const cmp = compareQuotes({
    'M&S': { pricePence: 725, size: '750g' },
    Aldi: { pricePence: 759, size: '750g' },
  });
  assert.deepEqual(cmp.cheapest, ['M&S']);
  assert.equal(cmp.basis, 'unit');
});

test('compares per kg when pack sizes differ', () => {
  // 500g for £5.00 (£10/kg) vs 1kg for £9.00 (£9/kg): the bigger pack wins.
  const cmp = compareQuotes({
    Aldi: { pricePence: 500, size: '500g' },
    'M&S': { pricePence: 900, size: '1kg' },
  });
  assert.deepEqual(cmp.cheapest, ['M&S']);
});

test('falls back to price and flags it when sizes cannot be compared', () => {
  const cmp = compareQuotes({
    Aldi: { pricePence: 500, size: '500g' },
    'M&S': { pricePence: 450, size: '' },
  });
  assert.equal(cmp.basis, 'price');
  assert.equal(cmp.comparable, false);
  assert.deepEqual(cmp.cheapest, ['M&S']);
});

test('no sizes at all compares on price without a warning', () => {
  const cmp = compareQuotes({ Aldi: { pricePence: 99, size: '' }, 'M&S': { pricePence: 120, size: '' } });
  assert.equal(cmp.comparable, true);
  assert.deepEqual(cmp.cheapest, ['Aldi']);
});

test('ties list every cheapest shop; a single price compares nothing', () => {
  assert.deepEqual(
    compareQuotes({ Aldi: { pricePence: 100, size: '' }, 'M&S': { pricePence: 100, size: '' } }).cheapest,
    ['Aldi', 'M&S'],
  );
  assert.deepEqual(compareQuotes({ Aldi: { pricePence: 100, size: '' } }).cheapest, []);
  assert.deepEqual(
    compareQuotes({ Aldi: { pricePence: null, size: '1kg' }, 'M&S': { pricePence: 1, size: '' } }).cheapest,
    [],
  );
});

test('savingPence compares against the other shop', () => {
  const quotes = { 'M&S': { pricePence: 725, size: '750g' }, Aldi: { pricePence: 759, size: '750g' } };
  assert.equal(savingPence({ quotes, bought: { store: 'M&S', pricePence: 725 } }), 34);
  assert.equal(savingPence({ quotes, bought: { store: 'Aldi', pricePence: 759 } }), -34);
  // Paid less than the quote (e.g. a till discount): the saving reflects what was paid.
  assert.equal(savingPence({ quotes, bought: { store: 'M&S', pricePence: 700 } }), 59);
});

test('savingPence scales by pack size', () => {
  // Bought 1kg at £9; 500g elsewhere was £5, so 1kg there would be £10.
  const quotes = { Aldi: { pricePence: 500, size: '500g' }, 'M&S': { pricePence: 900, size: '1kg' } };
  assert.equal(savingPence({ quotes, bought: { store: 'M&S', pricePence: 900 } }), 100);
});

test('savingPence is unknown without a comparison', () => {
  assert.equal(savingPence({ quotes: {}, bought: { store: 'Aldi', pricePence: 100 } }), null);
  assert.equal(
    savingPence({
      quotes: { 'M&S': { pricePence: 100, size: '' } },
      bought: { store: 'Aldi', pricePence: 90 },
    }),
    null,
  );
  assert.equal(
    savingPence({
      quotes: { Aldi: { pricePence: 90, size: '500g' }, 'M&S': { pricePence: 100, size: '' } },
      bought: { store: 'Aldi', pricePence: 90 },
    }),
    null,
  );
  assert.equal(savingPence({ quotes: {}, bought: null }), null);
});
