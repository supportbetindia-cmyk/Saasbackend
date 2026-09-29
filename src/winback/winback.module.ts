import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WinbackService } from './winback.service';
import { WinbackScheduler } from './winback.scheduler';
import { WinbackController } from './winback.controller';
import { WinbackCronController } from './winback-cron.controller';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule],
  controllers: [WinbackController, WinbackCronController],
  providers: [WinbackService, WinbackScheduler],
})
export class WinbackModule {}
