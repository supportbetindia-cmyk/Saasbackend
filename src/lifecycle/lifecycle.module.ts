import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LifecycleController } from './lifecycle.controller';
import { LifecycleService } from './lifecycle.service';
import { LifecycleSenderService } from './lifecycle-sender.service';
import { LifecycleSenderScheduler } from './lifecycle-sender.scheduler';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule],
  controllers: [LifecycleController],
  providers: [LifecycleService, LifecycleSenderService, LifecycleSenderScheduler],
  exports: [LifecycleService],
})
export class LifecycleModule {}
