import assert from 'node:assert/strict';
import test from 'node:test';
import { DepartmentsService } from '../dist/departments/departments.service.js';

test('department reorder requires every active tenant department exactly once', async () => {
  let calls = 0;
  const prisma = {
    $queryRawUnsafe: async () => ++calls === 1 ? [{ id: 'a' }, { id: 'b' }] : [],
    $executeRawUnsafe: () => Promise.resolve(1),
    $transaction: async (updates) => Promise.all(updates),
  };
  const service = new DepartmentsService(prisma);
  await service.reorder('tenant-1', ['b', 'a']);

  calls = 0;
  await assert.rejects(() => service.reorder('tenant-1', ['a']), /Include every active department exactly once/);
});
