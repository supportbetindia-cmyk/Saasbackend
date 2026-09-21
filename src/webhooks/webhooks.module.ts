import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [PrismaModule, TransactionsModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}

