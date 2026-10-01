import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { InboxService } from './inbox.service';
import { InboxController } from './inbox.controller';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
