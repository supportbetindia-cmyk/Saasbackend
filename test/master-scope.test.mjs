import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMasterId } from '../dist/customers/master-scope.js';

test('unrestricted member gets what they ask for (none = all masters)', () => {
  assert.equal(resolveMasterId(undefined, []), undefined);
  assert.equal(resolveMasterId('gold001', []), 'gold001');
});

test('restricted member is pinned to their masters', () => {
  assert.equal(resolveMasterId(undefined, ['ads001', 'sil001']), 'ads001');
  assert.equal(resolveMasterId('', ['ads001']), 'ads001');
  assert.equal(resolveMasterId('sil001', ['ads001', 'sil001']), 'sil001');
  assert.throws(() => resolveMasterId('gold001', ['ads001']), /No access to this master/);
});
