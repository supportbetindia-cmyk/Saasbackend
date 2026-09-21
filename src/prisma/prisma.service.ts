import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    // A transient pooler blip shouldn't crash boot — Prisma reconnects on first query.
    await this.$connect().catch((e) => Logger.warn(`DB connect deferred: ${e.message}`, 'Prisma'));
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
