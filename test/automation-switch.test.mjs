import assert from 'node:assert/strict';
import test from 'node:test';
import { automationAllowed } from '../dist/whatsapp/automation-switch.js';

const db = (settings) => ({
  $queryRawUnsafe: async (_sql, keys) => keys.filter((k) => k in settings).map((k) => ({ value: settings[k] })),
});

test('master off blocks everything', async () => {
  assert.equal(await automationAllowed(db({ automation_enabled: 'false', automation_deposit: 'true' }), 'automation_deposit'), false);
});
test('per-type switch blocks only that type', async () => {
  const s = db({ automation_enabled: 'true', automation_deposit: 'false' });
  assert.equal(await automationAllowed(s, 'automation_deposit'), false);
  assert.equal(await automationAllowed(s, 'automation_withdrawal'), true);
});
test('untouched switches count as on; unreadable switches fail closed', async () => {
  assert.equal(await automationAllowed(db({}), 'automation_deposit'), true);
  assert.equal(await automationAllowed({ $queryRawUnsafe: async () => { throw new Error('db down'); } }), false);
});
