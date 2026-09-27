import { Injectable } from '@nestjs/common';
import { DashboardService } from '../dashboard/dashboard.service';
import { PrismaService } from '../prisma/prisma.service';

export type ReportType = 'daily' | 'weekly' | 'monthly';
const PERIOD = { daily: 'today', weekly: 'week', monthly: 'month' } as const;
const TARGET_KPI = { profit: 'companyPl', deposits: 'deposits', ftd: 'ftd', customers: 'newCustomers' } as const;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly dashboard: DashboardService) {}

  async get(tenantId: string, type: ReportType, masterId?: string) {
    const overview = await this.dashboard.overview(tenantId, PERIOD[type], undefined, undefined, masterId);
    const result = {
      type,
      generatedAt: new Date(),
      overview,
      traceability: {
        source: masterId ? `Master ${masterId}: customers and financially successful transactions within this company` : 'Tenant-scoped customers and financially successful transactions',
        companyPlFormula: 'Successful deposits - successful withdrawals',
        comparison: overview.label,
      },
    };
    if (type !== 'monthly') return result;

    const [allocations, targets] = await Promise.all([
      this.prisma.allocation.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.target.findMany({ where: { tenantId, period: 'month' }, orderBy: { metric: 'asc' } }),
    ]);
    const profit = overview.kpis.companyPl.current;
    return {
      ...result,
      allocations: allocations.map((item) => ({
        id: item.id, name: item.name, isRetained: item.isRetained,
        percent: Number(item.percent), amount: Math.round(profit * Number(item.percent)) / 100,
      })),
      targets: targets.map((target) => {
        const actual = overview.kpis[TARGET_KPI[target.metric as keyof typeof TARGET_KPI]].current;
        const value = Number(target.targetValue);
        return { metric: target.metric, target: value, actual, remaining: value - actual, achievementPct: value > 0 ? Math.round(actual / value * 1000) / 10 : null };
      }),
    };
  }
}
