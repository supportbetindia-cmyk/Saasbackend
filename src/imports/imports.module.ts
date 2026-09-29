import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ClassificationModule } from '../classification/classification.module';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { LiveSyncService } from './live-sync.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule, ClassificationModule, LifecycleModule],
  controllers: [ImportsController],
  providers: [ImportsService, LiveSyncService],
})
export class ImportsModule {}

