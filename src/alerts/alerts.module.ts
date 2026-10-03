import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AlertsService } from './alerts.service';
import { AlertsController } from './alerts.controller';
import { AlertsScheduler } from './alerts.scheduler';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AlertsController],
  providers: [AlertsService, AlertsScheduler],
})
export class AlertsModule {}
