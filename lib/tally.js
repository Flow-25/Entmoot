'use strict';

// Pure vote-counting functions. Each takes the list of option ids and the list of ballots
// and returns results sorted best-first: [{ option, score, rank }].
// Ties share a rank (competition ranking: 1, 1, 3) and keep the original option order.
// Ballot shapes:
//   approval: { approved: [optionId, ...] }
//   score:    { scores: { [optionId]: number } }
//   ranked:   { ranking: [optionId, ...] }   (best first; unranked options are tied last)
// References to options that are not in `options` are ignored.

function rankByScore(options, scoreOf) {
  const rows = options.map((option, index) => ({ option, score: scoreOf(option), index }));
  rows.sort((a, b) => b.score - a.score || a.index - b.index);
  let rank = 0;
  return rows.map((row, i) => {
    if (i === 0 || row.score !== rows[i - 1].score) rank = i + 1;
    return { option: row.option, score: row.score, rank };
  });
}

function approval(options, ballots) {
  const counts = new Map(options.map(o => [o, 0]));
  for (const ballot of ballots) {
    for (const o of new Set(ballot?.approved || [])) {
      if (counts.has(o)) counts.set(o, counts.get(o) + 1);
    }
  }
  return rankByScore(options, o => counts.get(o));
}

function score(options, ballots) {
  const totals = new Map(options.map(o => [o, 0]));
  for (const ballot of ballots) {
    const scores = ballot?.scores || {};
    for (const o of options) {
      const v = Object.hasOwn(scores, o) ? Number(scores[o]) : 0;
      if (Number.isFinite(v)) totals.set(o, totals.get(o) + v);
    }
  }
  return rankByScore(options, o => totals.get(o));
}

// Returns { results, pairwise } where pairwise[a][b] = number of voters preferring a over b.
// In results, `score` is the number of rivals the option beats on strongest paths.
function schulze(options, ballots) {
  const n = options.length;
  const d = options.map(() => new Array(n).fill(0));

  for (const ballot of ballots) {
    const pos = new Map();
    for (const o of ballot?.ranking || []) {
      if (!pos.has(o)) pos.set(o, pos.size);
    }
    const at = options.map(o => (pos.has(o) ? pos.get(o) : Infinity));
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        if (at[a] < at[b]) d[a][b]++;
      }
    }
  }

  // Strongest paths (Floyd–Warshall variant), strength measured by winning votes.
  const p = d.map((row, a) => row.map((v, b) => (a !== b && v > d[b][a] ? v : 0)));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        p[j][k] = Math.max(p[j][k], Math.min(p[j][i], p[i][k]));
      }
    }
  }

  // "a beats b" (p[a][b] > p[b][a]) is a strict partial order, so counting wins orders it.
  const wins = new Map(
    options.map((o, a) => [o, options.filter((_, b) => a !== b && p[a][b] > p[b][a]).length])
  );

  const pairwise = {};
  options.forEach((a, i) => {
    pairwise[a] = {};
    options.forEach((b, j) => {
      if (i !== j) pairwise[a][b] = d[i][j];
    });
  });

  return { results: rankByScore(options, o => wins.get(o)), pairwise };
}

module.exports = { approval, score, schulze };
