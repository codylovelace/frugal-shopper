import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLine, splitQuantity, parsePastedList, MAX_PASTED_ITEMS } from '../public/js/paste.js';

test('cleanLine strips checklist, bullet and number markers', () => {
  const cases = {
    Milk: 'Milk',
    '  Beef mince 5%  ': 'Beef mince 5%',
    '- [ ] Bread': 'Bread',
    '- [x] Eggs': 'Eggs',
    '* [ ] Butter': 'Butter',
    '[ ] Cheese': 'Cheese',
    '☐ Apples': 'Apples',
    '☑ Bananas': 'Bananas',
    '✅ Pasta': 'Pasta',
    '• Rice': 'Rice',
    '◦ Beans': 'Beans',
    '- Tea': 'Tea',
    '– Coffee': 'Coffee',
    '1. Onions': 'Onions',
    '12) Garlic': 'Garlic',
    '- ☐ Carrots': 'Carrots',
    '-': '',
    '☐': '',
    '   ': '',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(cleanLine(input), expected, JSON.stringify(input));
  }
});

test('cleanLine keeps quantities and sizes that are part of the item', () => {
  assert.equal(cleanLine('2x Milk'), '2x Milk');
  assert.equal(cleanLine('1.5kg chicken'), '1.5kg chicken');
  assert.equal(cleanLine('6 eggs'), '6 eggs');
  assert.equal(cleanLine('- 4 pints milk'), '4 pints milk');
});

test('cleanLine truncates very long lines to the item name limit', () => {
  assert.equal(cleanLine('x'.repeat(150)).length, 100);
});

test('parsePastedList splits lines, drops blanks and duplicates', () => {
  const text = '- [ ] Milk\r\n\n☐ Bread\nmilk\n  \n• Eggs\n- [x] Bread\n';
  assert.deepEqual(parsePastedList(text), {
    items: [
      { name: 'Milk', quantity: 1 },
      { name: 'Bread', quantity: 1 },
      { name: 'Eggs', quantity: 1 },
    ],
    skipped: 2,
    truncated: false,
  });
});

test('parsePastedList skips items already on the list', () => {
  const r = parsePastedList('Milk\nBread\nJam', ['bread', 'Butter']);
  assert.deepEqual(
    r.items.map((i) => i.name),
    ['Milk', 'Jam'],
  );
  assert.equal(r.skipped, 1);
});

test('parsePastedList caps a huge paste', () => {
  const text = Array.from({ length: MAX_PASTED_ITEMS + 5 }, (_, i) => `Item ${i}`).join('\n');
  const r = parsePastedList(text);
  assert.equal(r.items.length, MAX_PASTED_ITEMS);
  assert.equal(r.truncated, true);
});

test('parsePastedList copes with empty input', () => {
  assert.deepEqual(parsePastedList(''), { items: [], skipped: 0, truncated: false });
  assert.deepEqual(parsePastedList(null), { items: [], skipped: 0, truncated: false });
});

test('splitQuantity reads "2x milk" and "milk x2" style quantities', () => {
  const cases = {
    '2x Milk': ['Milk', 2],
    '2 x Milk': ['Milk', 2],
    '3× Yoghurt': ['Yoghurt', 3],
    'Milk x2': ['Milk', 2],
    'Milk x 2': ['Milk', 2],
    'Milk ×12': ['Milk', 12],
    // Pack sizes and plain counts stay part of the name.
    '4 x 330ml Coke': ['4 x 330ml Coke', 1],
    'Coke 4x330ml': ['Coke 4x330ml', 1],
    '6 eggs': ['6 eggs', 1],
    Milk: ['Milk', 1],
    Xbox: ['Xbox', 1],
    '0x Milk': ['0x Milk', 1],
  };
  for (const [input, [name, quantity]] of Object.entries(cases)) {
    assert.deepEqual(splitQuantity(input), { name, quantity }, input);
  }
});

test('parsePastedList carries quantities and dedupes on the name alone', () => {
  const r = parsePastedList('- [ ] 2x Milk\n☐ Bread x3\nmilk');
  assert.deepEqual(r.items, [
    { name: 'Milk', quantity: 2 },
    { name: 'Bread', quantity: 3 },
  ]);
  assert.equal(r.skipped, 1);
});
