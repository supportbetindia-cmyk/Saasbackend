import { createHash } from 'node:crypto';

// Builds the WhatsApp template message for a transaction webhook — ported from the
// frontend automation so the VPS webhook sends the exact same messages.

export type TxnType = 'deposit' | 'withdrawal';
type Outcome = 'approved' | 'pending' | 'rejected';
export type Templates = Record<string, string>;

// The 6 default approved Interakt template names (the 'updates' account defaults).
// Change them per-tenant via the WhatsApp settings; these are the fallback.
export const DEFAULT_TEMPLATES: Templates = {
  deposit_approved: 'deposit_approved',
  deposit_pending: 'deposit_request_received_dk',
  deposit_rejected: 'deposit_rejected',
  withdrawal_approved: 'withdrawal_approved',
  withdrawal_pending: 'withdrawal_request_received',
  withdrawal_rejected: 'withdrawal_rejected',
};

const IST_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const IST_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });

// Rejected is checked FIRST — "reject_completed" also contains "complet".
export function classifyOutcome(status: string): Outcome {
  const s = (status || '').toLowerCase();
  if (/reject|fail|cancel|declin/.test(s)) return 'rejected';
  if (/approv|success|complet|credit/.test(s)) return 'approved';
  return 'pending';
}

// Indian 10-digit mobile, tolerant of country-code prefixes.
export function normalizePhone(raw: string): { countryCode: string; phoneNumber: string } | null {
  const digits = (raw || '').replace(/\D/g, '');
  let local: string | null = null;
  if (digits.length === 10) local = digits;
  else if (digits.length === 11 && digits.startsWith('0')) local = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('91')) local = digits.slice(2);
  else if (digits.length === 13 && digits.startsWith('910')) local = digits.slice(3);
  else if (digits.length > 10) local = digits.slice(-10);
  if (!local || !/^[6-9]\d{9}$/.test(local)) return null;
  return { countryCode: '+91', phoneNumber: local };
}

function pick(body: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = body[k];
    if (v !== undefined && v !== null && v !== '') return String(v).trim();
  }
  return '';
}

export type BuiltMessage = {
  eventKey: string;
  templateName: string;
  phoneNumber: string;
  countryCode: string;
  bodyValues: string[];
};

/** Build the message for a transaction, or null if there's no usable phone. */
export function buildTransactionMessage(type: TxnType, body: Record<string, unknown>, templates: Templates = DEFAULT_TEMPLATES): BuiltMessage | null {
  const phone = normalizePhone(pick(body, 'mobile_number', 'Mobile_number'));
  if (!phone) return null;

  const name = pick(body, 'User_name', 'user_name') || 'Customer';
  const userId = pick(body, 'user_id', 'User_id');
  const amount = pick(body, 'Amount', 'amount');
  const transactionId = pick(body, 'Transaction_id', 'transaction_id');
  const status = pick(body, 'payment_status', 'Payment_status', 'status', 'Status');
  const remarks = pick(body, 'remarks', 'Remarks');

  const outcome = classifyOutcome(status);
  const templateName = templates[`${type}_${outcome}`] || DEFAULT_TEMPLATES[`${type}_${outcome}`];
  const now = new Date();
  // {{1}} name {{2}} userId {{3}} amount {{4}} INR {{5}} txnId {{6}} date {{7}} time; rejected adds {{8}} reason.
  const base = [name, userId, amount, 'INR', transactionId, IST_DATE.format(now), IST_TIME.format(now).toUpperCase()];
  const bodyValues = outcome === 'rejected' ? [...base, remarks || 'Not specified'] : base;

  const identity = transactionId || createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const eventKey = createHash('sha256').update(`${type}|${identity}|${outcome}|${templateName}`).digest('hex');
  return { eventKey, templateName, phoneNumber: phone.phoneNumber, countryCode: phone.countryCode, bodyValues };
}
