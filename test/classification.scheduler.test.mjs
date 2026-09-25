import assert from 'node:assert/strict';
import test from 'node:test';
import { ClassificationScheduler } from '../dist/classification/classification.scheduler.js';
import { ClassificationCronController } from '../dist/classification/classification-cron.controller.js';

test('scheduled classification isolates failures and continues with other tenants', async () => {
  const prisma = { tenant: { findMany: async () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } };
  const classification = { recomputeTenant: async (id) => id === 'a' ? { changed: 3 } : Promise.reject(new Error('DB unavailable')) };
  const audited = [];
  const audit = { log: async (entry) => audited.push(entry) };
  const result = await new ClassificationScheduler(prisma, classification, audit).runAll();

  assert.equal(result.ok, false);
  assert.equal(result.processedTenants, 2);
  assert.equal(result.changedCustomers, 3);
  assert.equal(result.results[1].error, 'DB unavailable');
  assert.equal(audited.length, 1);
});

test('classification cron requires the configured bearer secret', async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-secret';
  const controller = new ClassificationCronController({ runAll: async () => ({ ok: true }) });
  assert.throws(() => controller.run('Bearer wrong-secret'), /Invalid cron secret/);
  assert.deepEqual(await controller.run('Bearer test-secret'), { ok: true });
  if (previous === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previous;
});
