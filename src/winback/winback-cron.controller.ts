import { timingSafeEqual } from 'node:crypto';
import { Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { WinbackScheduler } from './winback.scheduler';

// External daily trigger (same shape as /cron/classification). The internal timer
// already runs this daily; this endpoint lets a cron service drive it too.
@Controller('cron/winback')
export class WinbackCronController {
  constructor(private readonly scheduler: WinbackScheduler) {}

  @Post()
  run(@Headers('authorization') authorization?: string) {
    const configured = process.env.CRON_SECRET;
    const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!configured || !sameSecret(configured, supplied)) throw new UnauthorizedException('Invalid cron secret');
    return this.scheduler.runAll();
  }
}

function sameSecret(expected: string, supplied: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
