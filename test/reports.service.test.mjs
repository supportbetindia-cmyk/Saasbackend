import assert from 'node:assert/strict';
import test from 'node:test';
import { ReportsService } from '../dist/reports/reports.service.js';

const overview = {
  label: 'This month vs last month',
  kpis: {
    companyPl: { current: 1000 }, deposits: { current: 1500 },
    ftd: { current: 4 }, newCustomers: { current: 8 },
  },
};

test('monthly report reuses dashboard values for allocations and targets', async () => {
  const prisma = {
    allocation: { findMany: async () => [{ id: 'a1', name: 'Operations', isRetained: false, percent: 30 }] },
    target: { findMany: async () => [{ metric: 'profit', targetValue: 2000 }] },
  };
  const dashboard = { overview: async () => overview };
  const report = await new ReportsService(prisma, dashboard).get('tenant-1', 'monthly');

  assert.equal(report.allocations[0].amount, 300);
  assert.deepEqual(report.targets[0], { metric: 'profit', target: 2000, actual: 1000, remaining: 1000, achievementPct: 50 });
});
