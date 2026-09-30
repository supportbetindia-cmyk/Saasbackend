import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { MessageRetryService } from './message-retry.service';

// How often to sweep the queue for due retries. Backoff lives on each row, so a tick
// only picks up rows whose next_attempt_at has already passed.
const INTERVAL_MS = 2 * 60 * 1000;

@Injectable()
export class MessageRetryScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('WhatsAppRetry');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly retry: MessageRetryService) {}

  onApplicationBootstrap() {
    // Opt-in: this re-sends real WhatsApp messages. Set WHATSAPP_RETRY_ENABLED=1 to arm it.
    if (process.env.WHATSAPP_RETRY_ENABLED !== '1') return;
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.log.log('retry scheduler armed');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // Skip a tick if the previous one is still running, so a slow run never overlaps itself.
  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.retry.runOnce();
    } catch (e) {
      this.log.warn(`retry tick failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
    }
  }
}
