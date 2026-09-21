import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AllocationsController } from './allocations.controller';
import { AllocationsService } from './allocations.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule, DashboardModule],
  controllers: [AllocationsController],
  providers: [AllocationsService],
})
export class AllocationsModule {}
