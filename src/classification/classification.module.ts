import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ClassificationController } from './classification.controller';
import { ClassificationService } from './classification.service';

@Module({
  imports: [PrismaModule, AuthModule, AuditModule],
  controllers: [ClassificationController],
  providers: [ClassificationService],
  exports: [ClassificationService],
})
export class ClassificationModule {}
