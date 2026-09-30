import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LifecycleController } from './lifecycle.controller';
import { LifecycleService } from './lifecycle.service';
import { LifecycleSenderService } from './lifecycle-sender.service';
import { LifecycleSenderScheduler } from './lifecycle-sender.scheduler';
import { LifecycleInboundController } from './lifecycle-inbound.controller';
import { LifecycleInboundService } from './lifecycle-inbound.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule],
  controllers: [LifecycleController, LifecycleInboundController],
  providers: [LifecycleService, LifecycleSenderService, LifecycleSenderScheduler, LifecycleInboundService],
  exports: [LifecycleService],
})
export class LifecycleModule {}
