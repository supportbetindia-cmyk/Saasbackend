import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from './alerts.service';

// Hourly: big withdrawals surface within the hour; VIP-inactive / FTD-drop rules are
// deduped per week/day, so running them hourly costs nothing extra.
const INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class AlertsScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Alerts');
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly prisma: PrismaService, private readonly alerts: AlertsService) {}

  onApplicationBootstrap() {
    // Opt-in so it never runs unexpectedly. Set ALERTS_ENABLED=1 to arm.
    if (process.env.ALERTS_ENABLED !== '1') return;
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.log.log('alerts scheduler armed');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const tenants = await this.prisma.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
      for (const t of tenants) {
        try {
          await this.alerts.runTenant(t.id);
        } catch (e) {
          this.log.debug(`skip ${t.id}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
