import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [PrismaModule],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
