'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { approval, score, schulze } = require('../lib/tally');

const order = results => results.map(r => r.option);
const ranked = (count, ranking) => Array.from({ length: count }, () => ({ ranking: [...ranking] }));

test('approval: most approvals wins', () => {
  const results = approval(['a', 'b', 'c'], [
    { approved: ['a', 'b'] },
    { approved: ['b'] },
    { approved: ['b', 'c', 'c', 'ghost'] },
  ]);
  assert.deepEqual(results, [
    { option: 'b', score: 3, rank: 1 },
    { option: 'a', score: 1, rank: 2 },
    { option: 'c', score: 1, rank: 2 },
  ]);
});

test('score: highest total wins', () => {
  const results = score(['a', 'b', 'c'], [
    { scores: { a: 5, b: 2 } },
    { scores: { a: 1, b: 3, c: 5 } },
    { scores: { c: 2, ghost: 5 } },
  ]);
  assert.deepEqual(results, [
    { option: 'c', score: 7, rank: 1 },
    { option: 'a', score: 6, rank: 2 },
    { option: 'b', score: 5, rank: 3 },
  ]);
});

test('schulze: Condorcet winner wins', () => {
  // b beats everyone head-to-head although a has the most first places.
  const { results, pairwise } = schulze(['a', 'b', 'c'], [
    ...ranked(4, ['a', 'b', 'c']),
    ...ranked(3, ['b', 'c', 'a']),
    ...ranked(2, ['c', 'b', 'a']),
  ]);
  assert.deepEqual(order(results), ['b', 'c', 'a']);
  assert.deepEqual(results.map(r => r.rank), [1, 2, 3]);
  assert.equal(pairwise.b.a, 5);
  assert.equal(pairwise.a.b, 4);
  assert.equal(pairwise.b.c, 7);
});

test('schulze: resolves a Condorcet cycle (Wikipedia example)', () => {
  const { results, pairwise } = schulze(['A', 'B', 'C', 'D', 'E'], [
    ...ranked(5, ['A', 'C', 'B', 'E', 'D']),
    ...ranked(5, ['A', 'D', 'E', 'C', 'B']),
    ...ranked(8, ['B', 'E', 'D', 'A', 'C']),
    ...ranked(3, ['C', 'A', 'B', 'E', 'D']),
    ...ranked(7, ['C', 'A', 'E', 'B', 'D']),
    ...ranked(2, ['C', 'B', 'A', 'D', 'E']),
    ...ranked(7, ['D', 'C', 'E', 'B', 'A']),
    ...ranked(8, ['E', 'B', 'A', 'D', 'C']),
  ]);
  assert.deepEqual(order(results), ['E', 'A', 'C', 'B', 'D']);
  assert.deepEqual(results.map(r => r.rank), [1, 2, 3, 4, 5]);
  assert.equal(pairwise.A.B, 20);
  assert.equal(pairwise.B.A, 25);
  assert.equal(pairwise.E.D, 31);
});

test('schulze: unranked options are tied last', () => {
  const { results, pairwise } = schulze(['a', 'b', 'c'], [{ ranking: ['b'] }, { ranking: ['b', 'a'] }]);
  assert.deepEqual(order(results), ['b', 'a', 'c']);
  assert.equal(pairwise.b.a, 2);
  assert.equal(pairwise.a.c, 1);
  assert.equal(pairwise.c.a, 0);
});

test('ties share a rank', () => {
  assert.deepEqual(approval(['a', 'b', 'c'], [{ approved: ['a', 'c'] }, { approved: ['b'] }]), [
    { option: 'a', score: 1, rank: 1 },
    { option: 'b', score: 1, rank: 1 },
    { option: 'c', score: 1, rank: 1 },
  ]);
  assert.deepEqual(score(['a', 'b', 'c'], [{ scores: { a: 3, b: 3, c: 1 } }]).map(r => r.rank), [1, 1, 3]);
  // A perfect cycle: nobody beats anybody on strongest paths.
  const { results } = schulze(['a', 'b', 'c'], [
    { ranking: ['a', 'b', 'c'] },
    { ranking: ['b', 'c', 'a'] },
    { ranking: ['c', 'a', 'b'] },
  ]);
  assert.deepEqual(results.map(r => r.rank), [1, 1, 1]);
  // No ballots at all: everything is tied.
  assert.deepEqual(schulze(['a', 'b'], []).results.map(r => r.rank), [1, 1]);
});
