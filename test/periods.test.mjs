import assert from 'node:assert/strict';
import test from 'node:test';
import { computeRanges } from '../dist/dashboard/periods.js';

test('custom range accepts epoch-ms strings (the UI format that used to 500)', () => {
  const r = computeRanges('Asia/Kolkata', 'custom', new Date(), '1793039400000', '1793125800000');
  assert.equal(r.current.start.getTime(), 1793039400000);
  assert.equal(r.current.end.getTime(), 1793125800000);
  assert.ok(!Number.isNaN(r.current.start.getTime()));
  // previous window = same length immediately before
  assert.equal(r.previous.end.getTime(), r.current.start.getTime());
});

test('custom range still accepts ISO strings', () => {
  const r = computeRanges('Asia/Kolkata', 'custom', new Date(), '2026-10-26T00:00:00.000Z', '2026-10-27T00:00:00.000Z');
  assert.equal(r.current.start.toISOString(), '2026-10-26T00:00:00.000Z');
});

test('named periods still work', () => {
  const r = computeRanges('Asia/Kolkata', 'week', new Date('2026-10-28T06:30:00.000Z'));
  assert.ok(r.current.start.getTime() < r.current.end.getTime());
  assert.equal(r.label, 'This week vs last week');
});

test('invalid custom range throws instead of silently producing NaN', () => {
  assert.throws(() => computeRanges('Asia/Kolkata', 'custom', new Date(), 'nonsense', 'also-bad'));
});
