import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { TargetsController } from './targets.controller';
import { TargetsService } from './targets.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule, DashboardModule],
  controllers: [TargetsController],
  providers: [TargetsService],
})
export class TargetsModule {}
