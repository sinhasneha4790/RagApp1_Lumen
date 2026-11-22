import test from 'node:test';
import assert from 'node:assert/strict';
import { tokens, tf, buildIndex, rank, dot } from '../public/lib/retrieval.js';

const unit = v => { const n = Math.hypot(...v); return Float32Array.from(v.map(x => x / n)); };
const mk = (text, emb) => ({ text, tf: tf(tokens(text)), emb });

test('tokens drop stop words and stem lightly', () => {
  assert.deepEqual(tokens('The returns are processing quickly'), ['return', 'process', 'quickly']);
});

test('hybrid score ranks a semantically closer chunk above a keyword-only match', () => {
  const semantic = mk('Unused goods may be sent back within thirty days for a full refund.', unit([1, 0.1, 0]));
  const keyword = mk('Return address label: return to sender, return desk, return policy page.', unit([0, 0, 1]));
  const other = mk('Tents carry a two year warranty against defects.', unit([0, 1, 0]));
  const chunks = [keyword, semantic, other];
  const idf = buildIndex(chunks);
  const q = 'How long do I have to return an item?';
  const qe = unit([1, 0, 0]);

  const kwOnly = rank(chunks, q, idf, null, 3);
  assert.equal(kwOnly[0].c, keyword, 'keyword search alone prefers the keyword chunk');

  const hybrid = rank(chunks, q, idf, qe, 3);
  assert.equal(hybrid[0].c, semantic);
  assert.ok(Math.abs(hybrid[0].score - (0.8 * dot(qe, semantic.emb) + 0.2 * 0)) < 1e-6);
  assert.ok(hybrid.every(h => h.sem != null));
});

test('falls back to keywords when there are no embeddings', () => {
  const chunks = [mk('Warranty covers manufacturing defects for two years.'), mk('Exchanges for size are free within 45 days.')];
  const idf = buildIndex(chunks);
  const hits = rank(chunks, 'what does the warranty cover', idf, null, 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].c, chunks[0]);
  assert.equal(hits[0].sem, null);
});

test('chunks without an embedding use keywords even when the query has one', () => {
  const a = mk('Refunds arrive within five business days.', unit([1, 0]));
  const b = mk('Refunds for international orders exclude duties.');
  const idf = buildIndex([a, b]);
  const hits = rank([a, b], 'refunds duties', idf, unit([1, 0]), 5);
  assert.equal(hits.find(h => h.c === b).sem, null);
});

test('respects k and drops non-positive scores', () => {
  const chunks = Array.from({ length: 10 }, (_, i) => mk(`Returns policy section ${i} explains refunds.`));
  const idf = buildIndex(chunks);
  assert.equal(rank(chunks, 'refunds', idf, null, 3).length, 3);
  assert.equal(rank(chunks, 'zebra', idf, null, 3).length, 0);
});
