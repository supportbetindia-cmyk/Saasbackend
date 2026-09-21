import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type TransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersService } from '../customers/customers.service';
import { normalizeStatus, normalizeType } from './status';

export type IngestInput = {
  // customer identity (a customer is upserted from these)
  externalUserId?: string | null;
  masterId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  // transaction
  externalTransactionId?: string | null;
  source?: string | null;
  transactionType: string; // deposit | withdrawal
  amount: number;
  currency?: string | null;
  occurredAt?: string | Date | null;
  status?: string | null; // raw provider status
  remarks?: string | null;
};

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
  ) {}

  /** Idempotent ingest: upsert customer, upsert transaction by (tenant, source,
   * external id), normalize status, then recompute the customer's FTD. */
  async ingest(tenantId: string, input: IngestInput) {
    const type = normalizeType(input.transactionType);
    if (!type) throw new BadRequestException('transactionType must be deposit or withdrawal');
    if (!Number.isFinite(input.amount)) throw new BadRequestException('amount must be a number');

    const customer = await this.customers.upsertByExternal(tenantId, {
      externalUserId: input.externalUserId,
      masterId: input.masterId,
      name: input.name,
      phone: input.phone,
      email: input.email,
    });

    const { normalized, successful } = normalizeStatus(input.status);
    const source = input.source || 'manual';
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const amount = new Prisma.Decimal(input.amount);

    const data = {
      tenantId,
      customerId: customer.id,
      externalTransactionId: input.externalTransactionId ?? null,
      source,
      transactionType: type,
      amount,
      currency: input.currency || 'INR',
      occurredAt,
      rawStatus: input.status ?? null,
      normalizedStatus: normalized,
      isFinanciallySuccessful: successful,
      remarks: input.remarks ?? null,
    };

    let txn;
    if (input.externalTransactionId) {
      txn = await this.prisma.transaction.upsert({
        where: {
          tenantId_source_externalTransactionId: {
            tenantId, source, externalTransactionId: input.externalTransactionId,
          },
        },
        update: {
          amount, currency: data.currency, occurredAt, rawStatus: data.rawStatus,
          normalizedStatus: normalized, isFinanciallySuccessful: successful, remarks: data.remarks,
          transactionType: type, customerId: customer.id,
        },
        create: data,
      });
    } else {
      txn = await this.prisma.transaction.create({ data });
    }

    if (type === 'DEPOSIT') await this.recomputeFtd(tenantId, customer.id);
    return txn;
  }

  async recomputeFtd(tenantId: string, customerId: string): Promise<void> {
    const first = await this.prisma.transaction.findFirst({
      where: { tenantId, customerId, transactionType: 'DEPOSIT', isFinanciallySuccessful: true },
      orderBy: { occurredAt: 'asc' },
    });
    await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        ftdDate: first?.occurredAt ?? null,
        ftdAmount: first?.amount ?? null,
        ftdTransactionId: first?.id ?? null,
      },
    });
  }

  async list(tenantId: string, opts: { type?: string; status?: string; search?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? 50));
    const type = normalizeType(opts.type);
    const where: Prisma.TransactionWhereInput = {
      tenantId,
      ...(type ? { transactionType: type as TransactionType } : {}),
      ...(opts.status ? { normalizedStatus: opts.status.toUpperCase() as never } : {}),
      ...(opts.search
        ? { externalTransactionId: { contains: opts.search.trim(), mode: 'insensitive' } }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.transaction.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.transaction.count({ where }),
    ]);
    return { data, page, pageSize, total };
  }
}
