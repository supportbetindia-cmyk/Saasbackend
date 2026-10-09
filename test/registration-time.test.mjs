import assert from 'node:assert/strict';
import test from 'node:test';
import { registrationTime } from '../dist/webhooks/webhook.mapper.js';

const now = new Date('2026-10-10T06:00:00Z');
test('offset-less values are IST', () => {
  assert.equal(registrationTime('2026-10-09 14:30:00', now).toISOString(), '2026-10-09T09:00:00.000Z');
  assert.equal(registrationTime('2026-10-09', now).toISOString(), '2026-10-08T18:30:00.000Z');
});
test('explicit offsets are respected', () => {
  assert.equal(registrationTime('2026-10-09T14:30:00+05:30', now).toISOString(), '2026-10-09T09:00:00.000Z');
  assert.equal(registrationTime('2026-10-09T09:00:00Z', now).toISOString(), '2026-10-09T09:00:00.000Z');
});
test('missing or junk falls back to arrival time', () => {
  assert.equal(registrationTime(null, now), now);
  assert.equal(registrationTime('yesterday', now), now);
});
