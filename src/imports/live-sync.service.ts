import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClassificationService } from '../classification/classification.service';
import { ImportsService } from './imports.service';

const INTERVAL_MS = 120_000; // ponytail: fixed 2-min poll; make env-driven if a tenant needs faster.

/**
 * Keeps saas.* live with the webhook data landing in public.* — reuses the same
 * idempotent import + reclassify the manual buttons call, just on a timer.
 * ponytail: setInterval, not @nestjs/schedule (no dep); polls, no webhook fan-out.
 */
@Injectable()
export class LiveSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('LiveSync');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly imports: ImportsService,
    private readonly classification: ClassificationService,
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
          // Only tenants with a matching legacy public.* company sync here; others
          // (new tenants, no legacy source) throw "No legacy company" and are skipped.
          await this.imports.importLegacyCustomers(t.id, t.name);
          await this.imports.importLegacyTransactions(t.id, t.name);
          await this.classification.recomputeTenant(t.id);
        } catch (err) {
          this.log.debug(`skip ${t.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      this.log.error(`sync failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }
}
