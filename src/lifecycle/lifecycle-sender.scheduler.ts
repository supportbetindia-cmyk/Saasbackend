import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LifecycleSenderService } from './lifecycle-sender.service';

// Sends lifecycle messages once a day per company. Per-stage cooldown + follow-up
// caps live in the query, so an extra run (e.g. after a restart) never over-messages.
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 6 * 60 * 1000; // let stages settle after boot before sending

@Injectable()
export class LifecycleSenderScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Lifecycle');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: LifecycleSenderService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap() {
    // Opt-in: real marketing to live players. Set LIFECYCLE_SEND_ENABLED=1 to turn on
    // the daily auto-send. Until then it stays off; use POST /lifecycle/send/run to test.
    if (process.env.LIFECYCLE_SEND_ENABLED !== '1') return;
    setTimeout(() => {
      void this.runAll();
      this.timer = setInterval(() => void this.runAll(), INTERVAL_MS);
    }, FIRST_RUN_DELAY_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runAll() {
    if (this.running) return;
    this.running = true;
    try {
      const tenants = await this.prisma.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true } });
      for (const t of tenants) {
        try {
          const { configured, results } = await this.sender.runTenant(t.id);
          const sent = results.reduce((s, r) => s + r.sent, 0);
          const failed = results.reduce((s, r) => s + r.failed, 0);
          if (configured && (sent || failed)) {
            await this.audit.log({
              tenantId: t.id, action: 'lifecycle.sent', entityType: 'lifecycle',
              newValue: { sent, failed, byStage: results, at: new Date().toISOString() },
            });
          }
        } catch (e) {
          this.log.warn(`send failed for ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
