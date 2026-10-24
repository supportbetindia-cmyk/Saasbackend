import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClassificationService } from '../classification/classification.service';
import { LifecycleService } from '../lifecycle/lifecycle.service';

const INTERVAL_MS = 120_000; // ponytail: fixed 2-min poll; make env-driven if a tenant needs faster.

/**
 * Re-runs classification + lifecycle recompute for every tenant on a timer, so
 * stages/tiers follow the live ledger.
 * ponytail: setInterval, not @nestjs/schedule (no dep); polls, no webhook fan-out.
 */
@Injectable()
export class LiveSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('LiveSync');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly classification: ClassificationService,
    private readonly lifecycle: LifecycleService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.LIVE_SYNC_DISABLED === '1') return;
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    void this.tick(); // sync once at startup
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return; // skip if a slow run is still going
    this.running = true;
    try {
      const tenants = await this.prisma.tenant.findMany({ select: { id: true, name: true } });
      for (const t of tenants) {
        try {
          // The legacy public.* source is frozen (no writes since Sep 2026), so it is no
          // longer re-imported here: doing so every tick reset categories the classifier
          // then re-logged, growing classification_events by ~1M rows/day. The manual
          // import buttons still exist for a one-off bridge.
          await this.classification.recomputeTenant(t.id);
          await this.lifecycle.recomputeTenant(t.id);
        } catch (err) {
          this.log.debug(`skip ${t.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
      // Refresh the metrics materialized view (all tenants at once) when it's in use.
      // CONCURRENTLY = no read lock; catch so a missing/locked MV never breaks the tick.
      if (process.env.USE_METRICS_MV === '1') {
        await this.prisma.$executeRawUnsafe('refresh materialized view concurrently saas.mv_tenant_metrics')
          .catch((e) => this.log.debug(`mv refresh skipped: ${e instanceof Error ? e.message : e}`));
      }
    } catch (err) {
      this.log.error(`sync failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }
}
