import type { TransactionType, TxnStatus } from '@prisma/client';

export function normalizeStatus(raw: string | null | undefined): { normalized: TxnStatus; successful: boolean } {
  const s = (raw ?? '').toLowerCase();
  if (/no statement|absent|reject|declin|cancel/.test(s)) return { normalized: 'REJECTED', successful: false };
  if (/fail/.test(s)) return { normalized: 'FAILED', successful: false };
  if (/approv|success|complet|credit/.test(s)) return { normalized: 'APPROVED', successful: true };
  return { normalized: 'PENDING', successful: false };
}

export function normalizeType(raw: string | null | undefined): TransactionType | null {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('deposit')) return 'DEPOSIT';
  if (s.includes('withdraw')) return 'WITHDRAWAL';
  if (s === 'dep') return 'DEPOSIT';
  if (s === 'wd' || s === 'withdrawal') return 'WITHDRAWAL';
  return null;
}


export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return local;
}
