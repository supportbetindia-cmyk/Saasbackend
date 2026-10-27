import assert from 'node:assert/strict';
import test from 'node:test';
import { toCsv } from '../dist/common/csv.js';

test('header-only when no rows', () => {
  assert.equal(toCsv([], ['a', 'b']), 'a,b\n');
});

test('quotes fields with comma/quote/newline and escapes quotes', () => {
  const out = toCsv([{ a: 'x,y', b: 'he said "hi"', c: 'line1\nline2' }], ['a', 'b', 'c']);
  assert.equal(out, 'a,b,c\n"x,y","he said ""hi""","line1\nline2"\n');
});

test('neutralizes formula injection', () => {
  const out = toCsv([{ a: '=1+1', b: '+cmd', c: '-2', d: '@x' }], ['a', 'b', 'c', 'd']);
  assert.equal(out, "a,b,c,d\n'=1+1,'+cmd,'-2,'@x\n");
});

test('nulls/undefined render empty; numbers render plainly', () => {
  const out = toCsv([{ a: null, b: undefined, c: 500 }], ['a', 'b', 'c']);
  assert.equal(out, 'a,b,c\n,,500\n');
});
