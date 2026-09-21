import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardService } from '../dashboard/dashboard.service';
import type { PeriodKey } from '../dashboard/periods';

@Injectable()
export class AllocationsService {
  constructor(private readonly prisma: PrismaService, private readonly dashboard: DashboardService) {}

  create(tenantId: string, name: string, percent: number, isRetained: boolean) {
    return this.prisma.allocation.create({ data: { tenantId, name, percent, isRetained } });
  }

  async update(tenantId: string, id: string, data: { name?: string; percent?: number }) {
    await this.prisma.allocation.updateMany({ where: { id, tenantId }, data });
    return this.prisma.allocation.findFirst({ where: { id, tenantId } });
  }

  async remove(tenantId: string, id: string) {
    await this.prisma.allocation.deleteMany({ where: { id, tenantId } });
    return { ok: true };
  }

  /** Lines + live ₹ split of Company P/L for the period, with the 100% check (PRD 13). */
  async plan(tenantId: string, period: PeriodKey) {
    const [lines, overview] = await Promise.all([
      this.prisma.allocation.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
      this.dashboard.overview(tenantId, period),
    ]);
    const distributable = overview.kpis.companyPl.current;
    const totalPercent = Math.round(lines.reduce((s, l) => s + Number(l.percent), 0) * 100) / 100;
    return {
      period,
      distributable,
      totalPercent,
      unallocated: Math.round((100 - totalPercent) * 100) / 100,
      // "Active allocation total must equal exactly 100%" — else block/warn (PRD 13).
      valid: totalPercent === 100,
      lines: lines.map((l) => ({
        id: l.id, name: l.name, isRetained: l.isRetained,
        percent: Number(l.percent),
        amount: Math.round(distributable * (Number(l.percent) / 100) * 100) / 100,
      })),
    };
  }
}
