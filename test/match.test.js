import test from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, looksLikeSameItem } from '../public/js/match.js';

test('nameKey treats case, spacing, plurals and size spelling as the same item', () => {
  const same = [
    ['Oats', 'oat'],
    ['500g Oats', '500 g oats'],
    ['500g oats', '0.5kg Oats'],
    ['Tomatoes', 'tomato'],
    ['Eggs', 'egg'],
    ['Bananas', 'banana'],
    ['Apples', 'apple'],
    ['Cherries', 'cherry'],
    ['1 litre milk', '1000ml Milk'],
    ['Fish & chips', 'fish and chips'],
    ['  Bread  ', 'bread.'],
    ['Glass cleaner', 'glass cleaner'],
    ['Beef mince 5%', '5% beef mince'],
  ];
  for (const [a, b] of same) assert.equal(nameKey(a), nameKey(b), `${a} / ${b}`);
  assert.notEqual(nameKey('500g oats'), nameKey('1kg oats'));
  assert.notEqual(nameKey('Milk'), nameKey('Oat milk'));
});

test('looksLikeSameItem suggests near matches like the oats example', () => {
  assert.equal(looksLikeSameItem('500g oats', '500g rolled oats'), true);
  assert.equal(looksLikeSameItem('Oats', '500g rolled oats'), true);
  assert.equal(looksLikeSameItem('Semi skimmed milk', 'semi-skimmed milk 4 pints'), true);
  assert.equal(looksLikeSameItem('Free range eggs', 'Eggs'), true);
  // Still offered, because only the user can tell; "Keep separate" dismisses it.
  assert.equal(looksLikeSameItem('Milk', 'Oat milk'), true);
});

test('looksLikeSameItem does not suggest unrelated or differently sized items', () => {
  assert.equal(looksLikeSameItem('500g oats', '1kg oats'), false);
  assert.equal(looksLikeSameItem('Bread', 'Butter'), false);
  assert.equal(looksLikeSameItem('Oats', 'oats'), false, 'identical names merge, no suggestion needed');
  assert.equal(looksLikeSameItem('Chicken thighs', 'Chicken stock cubes'), false);
  assert.equal(looksLikeSameItem('', 'Milk'), false);
  assert.equal(looksLikeSameItem('Oat milk', '500g oats'), false, 'oat milk is milk, not oats');
  assert.equal(looksLikeSameItem('Chicken breast', 'Chicken'), false);
});
