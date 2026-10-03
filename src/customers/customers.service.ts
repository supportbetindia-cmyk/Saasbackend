import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../transactions/status';
import { customerScope } from './master-scope';

// Mirrors INACTIVE_AFTER_DAYS in the dashboard's Players Status column — keep in sync.
const ACTIVITY_INACTIVE_DAYS = 7;

/** UTC instant of "today" midnight in the given IANA timezone (no DST inside a day for IST). */
function startOfTodayUtc(tz: string): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const msSinceLocalMidnight = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - msSinceLocalMidnight);
}

/** One call to the Claude Messages API. Returns the model's text, or throws. */
// async function callClaude(apiKey: string, system: string, user: string): Promise<string> {
//   const controller = new AbortController();
//   const timeout = setTimeout(() => controller.abort(), 20_000);
//   try {
//     const res = await fetch('https://api.anthropic.com/v1/messages', {
//       method: 'POST',
//       headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
//       body: JSON.stringify({
//         model: 'claude-haiku-4-5-20251001', // cheap + fast for per-player summaries
//         max_tokens: 400,
//         system,
//         messages: [{ role: 'user', content: user }],
//       }),
//       signal: controller.signal,
//     });
//     if (!res.ok) throw new Error(`AI request failed (${res.status})`);
//     const json = (await res.json()) as { content?: { text?: string }[] };
//     return json?.content?.[0]?.text ?? '';
//   } finally {
//     clearTimeout(timeout);
//   }
// }

/** One call to the OpenAI Chat Completions API. Returns the model's text, or throws. */
async function callOpenAI(apiKey: string, system: string, user: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',                            // Groq model (live list: GET /openai/v1/models); 120b = richer
        max_tokens: 400,
        response_format: { type: 'json_object' },   // guarantees valid JSON back
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`AI request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json?.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timeout);
  }
}


function daysAgo(iso: string | Date | null | undefined): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}



export type UpsertCustomerInput = {
  externalUserId?: string | null;
  masterId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  registrationAt?: string | Date | null;
};

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Find-or-create a customer by external User ID within a tenant. */
  async upsertByExternal(tenantId: string, input: UpsertCustomerInput) {
    const phoneNormalized = normalizePhone(input.phone);
    const reg = input.registrationAt ? new Date(input.registrationAt) : undefined;
    if (input.externalUserId) {
      return this.prisma.customer.upsert({
        where: { tenantId_externalUserId: { tenantId, externalUserId: input.externalUserId } },
        update: {
          masterId: input.masterId ?? undefined,
          name: input.name ?? undefined,
          phone: input.phone ?? undefined,
          phoneNormalized: phoneNormalized ?? undefined,
          email: input.email ?? undefined,
          registrationAt: reg,
        },
        create: {
          tenantId,
          externalUserId: input.externalUserId,
          masterId: input.masterId ?? null,
          name: input.name ?? null,
          phone: input.phone ?? null,
          phoneNormalized,
          email: input.email ?? null,
          registrationAt: reg ?? null,
        },
      });
    }
    return this.prisma.customer.create({
      data: {
        tenantId,
        name: input.name ?? null,
        phone: input.phone ?? null,
        phoneNormalized,
        email: input.email ?? null,
        registrationAt: reg ?? null,
      },
    });
  }

  async list(
    tenantId: string,
    opts: { search?: string; page?: number; pageSize?: number; missingRegistration?: boolean; masterId?: string; stage?: string; activity?: string },
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
    const where = this.listWhere(tenantId, opts);
    const [data, total] = await Promise.all([
    
      this.prisma.customer.findMany({
        where,
        orderBy: [{ totalDeposits: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.customer.count({ where }),
    ]);
    // Attach today's confirmed deposit/withdrawal totals for this page of players.
    const today = await this.todayTotals(tenantId, data.map((c) => c.id));
    const enriched = data.map((c) => ({
      ...c,
      todayDeposits: today.get(c.id)?.dep ?? 0,
      todayWithdrawals: today.get(c.id)?.wd ?? 0,
    }));
    return { data: enriched, page, pageSize, total };
  }

  /** The Prisma `where` for the players list — shared by list() and exportRows() so the
   * export always matches exactly what the filters show. */
  private listWhere(
    tenantId: string,
    opts: { search?: string; missingRegistration?: boolean; masterId?: string; stage?: string; activity?: string },
  ) {
    const q = (opts.search ?? '').trim();
    const digits = q.replace(/\D/g, '');
    const looksLikeName = q !== '' && /^[\p{L}\s.'-]+$/u.test(q);
    const searchOr = !q
      ? []
      : looksLikeName
        ? [
            { name: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
          ]
        : [
            { externalUserId: { equals: q, mode: 'insensitive' as const } },
            { masterId: { equals: q, mode: 'insensitive' as const } },
            { email: { equals: q, mode: 'insensitive' as const } },
            ...(digits.length >= 6 ? [{ phoneNormalized: { equals: digits } }] : []),
          ];
    const activeCutoff = new Date(Date.now() - ACTIVITY_INACTIVE_DAYS * 86_400_000);
    const activityAnd =
      opts.activity === 'active'
        ? [{ OR: [{ lastDepositAt: { gte: activeCutoff } }, { lastWithdrawalAt: { gte: activeCutoff } }] }]
        : opts.activity === 'inactive'
          ? [
              { OR: [{ lastDepositAt: { not: null } }, { lastWithdrawalAt: { not: null } }] },
              { OR: [{ lastDepositAt: null }, { lastDepositAt: { lt: activeCutoff } }] },
              { OR: [{ lastWithdrawalAt: null }, { lastWithdrawalAt: { lt: activeCutoff } }] },
            ]
          : [];
    return {
      ...customerScope(tenantId, opts.masterId),
      ...(opts.missingRegistration ? { registrationAt: null } : {}),
      ...(opts.stage ? { currentLifecycle: opts.stage } : {}),
      ...(searchOr.length ? { OR: searchOr } : {}),
      ...(activityAnd.length ? { AND: activityAnd } : {}),
    };
  }

  /** All players matching the current filters as a CSV string (capped for safety).
   * Lifetime figures only — no per-row "today" lookups, so it stays one query. */
  async exportCsv(
    tenantId: string,
    opts: { search?: string; missingRegistration?: boolean; masterId?: string; stage?: string; activity?: string },
  ): Promise<string> {
    const rows = await this.prisma.customer.findMany({
      where: this.listWhere(tenantId, opts),
      orderBy: [{ totalDeposits: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 50000,
    });
    const headers = [
      'Name', 'Player ID', 'Master ID', 'Phone', 'Stage', 'Group', 'Joined on',
      'First deposit', 'First deposit date', 'Last deposit', 'Last deposit date',
      'Total deposits', 'Deposit count', 'Total withdrawals', 'Withdrawal count',
      'Profit/Loss', 'Loss commission 3%',
    ];
    const n = (v: unknown) => (v == null || v === '' ? '' : String(Number(v)));
    const d = (v: Date | null) => (v ? v.toISOString().slice(0, 10) : '');
    // Escape a CSV cell: wrap in quotes and double any internal quotes.
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(cell).join(',')];
    for (const c of rows) {
      const pnl = c.netPnl == null ? null : Number(c.netPnl);
      const lossComm = pnl != null && pnl > 0 ? Math.round(pnl * 0.03) : 0;
      lines.push([
        c.name ?? '', c.externalUserId ?? '', c.masterId ?? '', c.phone ?? '',
        c.currentLifecycle ?? '', c.currentCategory ?? '', d(c.registrationAt),
        n(c.ftdAmount), d(c.ftdDate), n(c.lastDepositAmount), d(c.lastDepositAt),
        n(c.totalDeposits), c.depositCount ?? '', n(c.totalWithdrawals), c.withdrawalCount ?? '',
        pnl == null ? '' : String(pnl), lossComm || '',
      ].map(cell).join(','));
    }
    return lines.join('\n');
  }

  async masters(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ master_id: string }>>`
      select distinct master_id from saas.customers
      where tenant_id = ${tenantId} and master_id is not null and master_id <> ''
        and master_id <> 'statement-api' and master_id not like 'statement:%'
      order by master_id`;
    return rows.map((row) => row.master_id);
  }

  /** Tenant timezone (falls back to Asia/Kolkata). */
  private async tenantTz(tenantId: string): Promise<string> {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    return t?.timezone || 'Asia/Kolkata';
  }

  /** Today's confirmed deposit/withdrawal amount per customer id (tenant timezone). */
  private async todayTotals(tenantId: string, ids: string[]): Promise<Map<string, { dep: number; wd: number }>> {
    const map = new Map<string, { dep: number; wd: number }>();
    if (ids.length === 0) return map;
    const start = startOfTodayUtc(await this.tenantTz(tenantId));
    const end = new Date(start.getTime() + 86_400_000);
    const grouped = await this.prisma.transaction.groupBy({
      by: ['customerId', 'transactionType'],
      where: { tenantId, customerId: { in: ids }, isFinanciallySuccessful: true, occurredAt: { gte: start, lt: end } },
      _sum: { amount: true },
    });
    for (const g of grouped) {
      const e = map.get(g.customerId) ?? { dep: 0, wd: 0 };
      if (g.transactionType === 'DEPOSIT') e.dep = Number(g._sum.amount ?? 0);
      else e.wd = Number(g._sum.amount ?? 0);
      map.set(g.customerId, e);
    }
    return map;
  }

  /** Customer 360: identity + financial aggregates derived from transactions. */
  async get360(tenantId: string, customerId: string, masterId?: string) {
    const customer = await this.prisma.customer.findFirst({ where: { ...customerScope(tenantId, masterId), id: customerId } });
    if (!customer) throw new NotFoundException('Customer not found');

    // Lifecycle / value-tier change history (newest first) for this customer.
    const classificationHistory = await this.prisma.classificationEvent.findMany({
      where: { tenantId, customerId },
      orderBy: { changedAt: 'desc' },
      take: 20,
    });

    const base = { tenantId, customerId, isFinanciallySuccessful: true } as const;
    const [dep, wd] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { ...base, transactionType: 'DEPOSIT' },
        _sum: { amount: true }, _count: true, _min: { occurredAt: true }, _max: { occurredAt: true },
      }),
      this.prisma.transaction.aggregate({
        where: { ...base, transactionType: 'WITHDRAWAL' },
        _sum: { amount: true }, _count: true, _min: { occurredAt: true }, _max: { occurredAt: true },
      }),
    ]);

    const totalDeposits = Number(dep._sum.amount ?? 0);
    const depositCount = dep._count;
    const totalWithdrawals = Number(wd._sum.amount ?? 0);
    const withdrawalCount = wd._count;
    const lastDeposit = dep._max.occurredAt;
    const daysSinceLastDeposit = lastDeposit ? Math.floor((Date.now() - lastDeposit.getTime()) / 86_400_000) : null;

    const todayMap = await this.todayTotals(tenantId, [customerId]);
    const today = todayMap.get(customerId) ?? { dep: 0, wd: 0 };

    const num = (v: unknown) => (v == null ? null : Number(v));
    // Lifetime totals from the source report (public.users / CSV). These are the
    // authoritative deposit/withdrawal figures; the ledger below is only recent activity.
    const lifetime = {
      totalDeposits: num(customer.totalDeposits),
      depositCount: customer.depositCount,
      totalWithdrawals: num(customer.totalWithdrawals),
      withdrawalCount: customer.withdrawalCount,
      netPnl: num(customer.netPnl),
      totalBonus: num(customer.totalBonus),
      lastDepositAt: customer.lastDepositAt,
      lastDepositAmount: num(customer.lastDepositAmount),
      lastWithdrawalAt: customer.lastWithdrawalAt,
      lastWithdrawalAmount: num(customer.lastWithdrawalAmount),
    };

    return {
      customer,
      lifetime,
      // Recent/webhook ledger activity — only counts financially successful transactions.
      ledger: {
        totalDeposits,
        depositCount,
        averageDeposit: depositCount ? Math.round((totalDeposits / depositCount) * 100) / 100 : null,
        firstDeposit: dep._min.occurredAt,
        lastDeposit,
        totalWithdrawals,
        withdrawalCount,
        firstWithdrawal: wd._min.occurredAt,
        lastWithdrawal: wd._max.occurredAt,
        pl: totalDeposits - totalWithdrawals,
        daysSinceLastDeposit,
      },
      ftd: { date: customer.ftdDate, amount: num(customer.ftdAmount), transactionId: customer.ftdTransactionId },
      today: { deposits: today.dep, withdrawals: today.wd },
      classificationHistory,
    };
  }

  /** AI-written 360 summary + recommended next action. Sends STATS ONLY to Claude —
   * never name/phone/email — so no player PII leaves our system. On-demand (the UI
   * calls it on a button click), gated on ANTHROPIC_API_KEY. */
  async aiSummary(tenantId: string, customerId: string): Promise<{ configured: boolean; summary: string | null; action: string | null }> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return { configured: false, summary: null, action: null };
    const d = await this.get360(tenantId, customerId);

    // PII-free context — numbers and stage only.
    const ctx = {
      currency: 'INR',
      stage: d.customer.currentLifecycle,
      valueTier: d.customer.currentCategory,
      registeredDaysAgo: daysAgo(d.customer.registrationAt),
      lifetimeDeposits: d.lifetime.totalDeposits,
      depositCount: d.lifetime.depositCount,
      lifetimeWithdrawals: d.lifetime.totalWithdrawals,
      netPnlHouse: d.lifetime.netPnl,
      firstDepositAmount: d.ftd.amount,
      firstDepositDaysAgo: daysAgo(d.ftd.date),
      lastDepositAmount: d.lifetime.lastDepositAmount,
      daysSinceLastDeposit: d.ledger.daysSinceLastDeposit,
    };

    const system =
      'You are a retention analyst for an online betting platform. From ONE player\'s stats (INR), write: ' +
      '(1) a 2-3 sentence plain-English summary of who they are and their current risk or opportunity, and ' +
      '(2) ONE concrete next action for the retention team (e.g. which WhatsApp nudge to send, or leave alone). ' +
      'Base everything ONLY on the numbers given — never invent data. Reply with strict JSON: {"summary": "...", "action": "..."}.';
    const text = await callOpenAI (apiKey, system, `Player stats:\n${JSON.stringify(ctx, null, 2)}`);

    try {
      const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { summary?: string; action?: string };
      return { configured: true, summary: j.summary ?? null, action: j.action ?? null };
    } catch {
      return { configured: true, summary: text || null, action: null };
    }
  }

  async transactionsFor(tenantId: string, customerId: string, opts: { page?: number; pageSize?: number }, masterId?: string) {
    const exists = await this.prisma.customer.findFirst({ where: { ...customerScope(tenantId, masterId), id: customerId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Customer not found');
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, opts.pageSize ?? 100));
    const where = { tenantId, customerId };
    const [data, total] = await Promise.all([
      this.prisma.transaction.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.transaction.count({ where }),
    ]);
    return { data, page, pageSize, total };
  }
}
