import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardService } from '../dashboard/dashboard.service';
import type { PeriodKey } from '../dashboard/periods';

export const TARGET_METRICS = ['profit', 'deposits', 'ftd', 'customers'] as const;
export const TARGET_PERIODS = ['month', 'quarter', 'year'] as const;
type Metric = (typeof TARGET_METRICS)[number];

// Which dashboard KPI backs each target metric.
const METRIC_KPI: Record<Metric, 'companyPl' | 'deposits' | 'ftd' | 'newCustomers'> = {
  profit: 'companyPl', deposits: 'deposits', ftd: 'ftd', customers: 'newCustomers',
};

@Injectable()
export class TargetsService {
  constructor(private readonly prisma: PrismaService, private readonly dashboard: DashboardService) {}

  async upsert(tenantId: string, metric: string, period: string, targetValue: number) {
    if (!TARGET_METRICS.includes(metric as Metric)) throw new BadRequestException('Invalid metric');
    if (!TARGET_PERIODS.includes(period as (typeof TARGET_PERIODS)[number])) throw new BadRequestException('Invalid period');
    return this.prisma.target.upsert({
      where: { tenantId_metric_period: { tenantId, metric, period } },
      update: { targetValue },
      create: { tenantId, metric, period, targetValue },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.prisma.target.deleteMany({ where: { id, tenantId } });
    return { ok: true };
  }

  /** All targets with live actual, remaining and achievement % (PRD 15). */
  async listWithProgress(tenantId: string, masterId?: string) {
    const targets = await this.prisma.target.findMany({ where: { tenantId }, orderBy: { metric: 'asc' } });
    if (targets.length === 0) return [];

    // One dashboard read per distinct period, then pull each metric's current value.
    const periods = [...new Set(targets.map((t) => t.period))] as PeriodKey[];
    const overviews = Object.fromEntries(
      await Promise.all(periods.map(async (p) => [p, await this.dashboard.overview(tenantId, p, undefined, undefined, masterId)] as const)),
    );

    return targets.map((t) => {
      const target = Number(t.targetValue);
      const actual = overviews[t.period].kpis[METRIC_KPI[t.metric as Metric]].current;
      return {
        id: t.id, metric: t.metric, period: t.period, target, actual,
        remaining: target - actual,
        // Zero/negative target → no misleading percentage (PRD 15).
        achievementPct: target > 0 ? Math.round((actual / target) * 1000) / 10 : null,
      };
    });
  }
}
