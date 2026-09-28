import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// A department's budget vs actual for one period (PRD 14). Actual is entered by the
// client (no expense feed in V1); everything else is derived at read time.
export type BudgetLine = {
  departmentId: string; name: string; budgetId: string | null;
  budget: number; actual: number; remaining: number; usedPct: number | null; overBudget: boolean;
};
export type BudgetView = {
  period: string;
  lines: BudgetLine[];
  summary: { totalBudget: number; totalActual: number; remaining: number; usedPct: number | null };
};

type Row = { departmentId: string; name: string; budgetId: string | null; budget: string; actual: string };

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/; // YYYY-MM

@Injectable()
export class BudgetsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active departments with their budget/actual for the period, derived totals included. */
  async list(tenantId: string, period: string): Promise<BudgetView> {
    if (!PERIOD_RE.test(period)) throw new BadRequestException('period must be YYYY-MM');
    const rows = await this.prisma.$queryRawUnsafe<Row[]>(
      `select d.id as "departmentId", d.name, b.id as "budgetId",
              coalesce(b.budget_amount, 0)::text as budget, coalesce(b.actual_amount, 0)::text as actual
       from saas.departments d
       left join saas.budgets b on b.tenant_id = d.tenant_id and b.department_id = d.id and b.period = $2
       where d.tenant_id = $1 and d.archived_at is null
       order by d.sort_order, d.name`,
      tenantId, period,
    );
    const lines: BudgetLine[] = rows.map((r) => {
      const budget = Number(r.budget);
      const actual = Number(r.actual);
      return {
        departmentId: r.departmentId, name: r.name, budgetId: r.budgetId,
        budget, actual, remaining: budget - actual,
        // Avoid a misleading % when budget is 0 (PRD 14).
        usedPct: budget > 0 ? Math.round((actual / budget) * 1000) / 10 : null,
        overBudget: budget > 0 && actual > budget,
      };
    });
    const totalBudget = lines.reduce((s, l) => s + l.budget, 0);
    const totalActual = lines.reduce((s, l) => s + l.actual, 0);
    return {
      period, lines,
      summary: {
        totalBudget, totalActual, remaining: totalBudget - totalActual,
        usedPct: totalBudget > 0 ? Math.round((totalActual / totalBudget) * 1000) / 10 : null,
      },
    };
  }

  /** Set a department's budget + actual for a period. One row per (dept, period) so
   * prior periods are never overwritten (PRD 14 history). */
  async upsert(tenantId: string, departmentId: string, period: string, budgetAmount: number, actualAmount: number) {
    if (!PERIOD_RE.test(period)) throw new BadRequestException('period must be YYYY-MM');
    const dept = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `select id from saas.departments where tenant_id = $1 and id = $2 and archived_at is null limit 1`, tenantId, departmentId,
    );
    if (!dept.length) throw new NotFoundException('Department not found');
    const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `insert into saas.budgets (id, tenant_id, department_id, period, budget_amount, actual_amount, created_at, updated_at)
       values (gen_random_uuid()::text, $1, $2, $3, $4, $5, now(), now())
       on conflict (tenant_id, department_id, period)
       do update set budget_amount = excluded.budget_amount, actual_amount = excluded.actual_amount, updated_at = now()
       returning id`,
      tenantId, departmentId, period, budgetAmount, actualAmount,
    );
    return { id: rows[0].id, departmentId, period, budgetAmount, actualAmount };
  }
}
