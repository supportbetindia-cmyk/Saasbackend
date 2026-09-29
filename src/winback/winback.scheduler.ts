import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { WinbackService, type WinbackResult } from './winback.service';

// Runs the win-back once a day per company. The 7-day cooldown lives in the query,
// so an extra run (e.g. after a restart) never double-messages anyone.
const INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000; // let the app settle before the first pass

@Injectable()
export class WinbackScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Winback');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly winback: WinbackService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap() {
    // Retired: superseded by the lifecycle sender, which owns the INACTIVE stage too.
    // Disabled here to avoid double-messaging. Re-enable only if you drop the lifecycle
    // sender. The manual /winback/preview and /winback/run endpoints still work.
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Send the win-back for every active company that has an enabled retention account. */
  async runAll(): Promise<{ ok: boolean; processedTenants: number; sent: number; results: Array<{ tenantId: string; name: string } & WinbackResult> }> {
    if (this.running) return { ok: true, processedTenants: 0, sent: 0, results: [] };
    this.running = true;
    try {
      const tenants = await this.prisma.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true } });
      const results: Array<{ tenantId: string; name: string } & WinbackResult> = [];
      // Sequential: don't spike the shared DB / Interakt as companies grow.
      for (const t of tenants) {
        try {
          const r = await this.winback.runTenant(t.id);
          results.push({ tenantId: t.id, name: t.name, ...r });
          if (r.sent || r.failed) {
            await this.audit.log({
              tenantId: t.id, action: 'winback.sent', entityType: 'winback',
              newValue: { sent: r.sent, failed: r.failed, eligible: r.eligible, at: new Date().toISOString() },
            });
          }
        } catch (e) {
          this.log.warn(`winback failed for ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
          results.push({ tenantId: t.id, name: t.name, eligible: 0, sent: 0, failed: 0, skipped: 0, reason: 'error' });
        }
      }
      return { ok: true, processedTenants: results.length, sent: results.reduce((s, r) => s + r.sent, 0), results };
    } finally {
      this.running = false;
    }
  }
}
