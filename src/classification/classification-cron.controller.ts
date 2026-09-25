import { timingSafeEqual } from 'node:crypto';
import { Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ClassificationScheduler } from './classification.scheduler';

@Controller('cron/classification')
export class ClassificationCronController {
  constructor(private readonly scheduler: ClassificationScheduler) {}

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
