import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type AuditEntry = {
  tenantId: string;
  actorUserId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  context?: unknown;
};

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Append-only audit record. Never throws into the caller's transaction path. */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: entry.tenantId,
          actorUserId: entry.actorUserId ?? null,
          action: entry.action,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          oldValue: (entry.oldValue ?? undefined) as never,
          newValue: (entry.newValue ?? undefined) as never,
          context: (entry.context ?? undefined) as never,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[audit] failed to write log:', err);
    }
  }
}
