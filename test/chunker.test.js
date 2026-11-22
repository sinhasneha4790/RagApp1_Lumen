import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../public/lib/chunker.js';

const sentence = i => `Sentence number ${i} talks about returns and refunds in some detail. `;
const long = Array.from({ length: 200 }, (_, i) => sentence(i)).join('');

test('respects chunk size', () => {
  for (const size of [300, 900, 3000]) {
    const cs = chunkText([{ page: null, text: long }], size, 150);
    assert.ok(cs.length > 1);
    for (const c of cs) assert.ok(c.text.length <= size, `${c.text.length} > ${size}`);
  }
});

test('consecutive chunks overlap by roughly the overlap setting', () => {
  const cs = chunkText([{ page: null, text: long }], 900, 150);
  for (let i = 1; i < cs.length; i++) {
    const tail = cs[i - 1].text.slice(-60);
    assert.ok(cs[i].text.includes(tail.slice(tail.indexOf(' ') + 1, 40)), `chunk ${i} does not overlap the previous one`);
  }
  const none = chunkText([{ page: null, text: long }], 900, 0);
  assert.ok(none.length < cs.length);
});

test('overlap is clamped to size − 50 (no infinite loop)', () => {
  const cs = chunkText([{ page: null, text: long }], 300, 600);
  assert.ok(cs.length > 0 && cs.length < long.length);
});

test('prefers to break at sentence ends', () => {
  const cs = chunkText([{ page: null, text: long }], 900, 150);
  for (const c of cs.slice(0, -1)) assert.match(c.text, /\.$/);
});

test('prefers paragraph breaks', () => {
  const para = 'word '.repeat(130).trim() + '\n\n' + 'next '.repeat(100);
  const [first] = chunkText([{ page: null, text: para }], 900, 0);
  assert.equal(first.text, 'word '.repeat(130).trim());
});

test('drops chunks of 20 characters or fewer and blank pages', () => {
  assert.deepEqual(chunkText([{ page: 1, text: 'tiny text' }, { page: 2, text: '   \n\n ' }], 900, 150), []);
  assert.equal(chunkText([{ page: 1, text: 'exactly twenty one c' + 'h' }], 900, 150).length, 1);
});

test('keeps page numbers', () => {
  const cs = chunkText([{ page: 1, text: long.slice(0, 2000) }, { page: 2, text: long.slice(2000, 4000) }], 900, 150);
  assert.deepEqual([...new Set(cs.map(c => c.page))], [1, 2]);
  assert.ok(cs.filter(c => c.page === 1).every(c => long.slice(0, 2000).includes(c.text)));
});

test('collapses runs of spaces and extra newlines', () => {
  const [c] = chunkText([{ page: null, text: 'Alpha    beta\t\tgamma\n\n\n\n\ndelta epsilon zeta' }], 900, 150);
  assert.equal(c.text, 'Alpha beta gamma\n\ndelta epsilon zeta');
});
