import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappService } from './whatsapp.service';
import { MessageRetryService } from './message-retry.service';
import { MessageRetryScheduler } from './message-retry.scheduler';

@Module({
  imports: [PrismaModule],
  providers: [WhatsappService, MessageRetryService, MessageRetryScheduler],
  exports: [WhatsappService, MessageRetryService],
})
export class WhatsappModule {}
