import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ClassificationController } from './classification.controller';
import { ClassificationService } from './classification.service';
import { ClassificationCronController } from './classification-cron.controller';
import { ClassificationScheduler } from './classification.scheduler';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule],
  controllers: [ClassificationController, ClassificationCronController],
  providers: [ClassificationService, ClassificationScheduler],
  exports: [ClassificationService],
})
export class ClassificationModule {}
