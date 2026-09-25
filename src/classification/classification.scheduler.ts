import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClassificationService } from './classification.service';

@Injectable()
export class ClassificationScheduler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly classification: ClassificationService,
    private readonly audit: AuditService,
  ) {}

  async runAll() {
    const tenants = await this.prisma.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true } });
    const results: { tenantId: string; name: string; changed: number; error?: string }[] = [];

    // Sequential by design: the daily job should not spike the shared database as tenants grow.
    for (const tenant of tenants) {
      try {
        const result = await this.classification.recomputeTenant(tenant.id, 'Daily inactivity schedule');
        results.push({ tenantId: tenant.id, name: tenant.name, changed: result.changed });
        await this.audit.log({
          tenantId: tenant.id, action: 'classification.scheduled', entityType: 'classification',
          newValue: { changed: result.changed, completedAt: new Date().toISOString() },
        });
      } catch (error) {
        results.push({ tenantId: tenant.id, name: tenant.name, changed: 0, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    return {
      ok: results.every((item) => !item.error),
      processedTenants: results.length,
      changedCustomers: results.reduce((sum, item) => sum + item.changed, 0),
      results,
    };
  }
}
