import { createHash } from 'node:crypto';
import type { IngestInput } from '../transactions/transactions.service';

export type WebhookType = 'deposit' | 'withdrawal';

function pick(body: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined && value !== null && value !== '') return String(value).trim();
  }
  return null;
}

export function mapWebhook(type: WebhookType, body: Record<string, unknown>): IngestInput {
  const externalUserId = pick(body, 'user_id', 'User_id');
  const externalTransactionId = pick(body, 'Transaction_id', 'transaction_id');
  const amount = Number(pick(body, 'Amount', 'amount'));
  if (!externalUserId) throw new Error('Missing user_id');
  if (!externalTransactionId) throw new Error('Missing transaction_id');
  if (!Number.isFinite(amount)) throw new Error('Invalid amount');

  return {
    externalUserId,
    externalTransactionId,
    masterId: pick(body, 'Branch_id', 'branch_id'),
    name: pick(body, 'User_name', 'user_name'),
    phone: pick(body, 'mobile_number', 'Mobile_number'),
    transactionType: type,
    amount,
    currency: pick(body, 'currency', 'Currency') || 'INR',
    occurredAt: pick(body, 'occurred_at', 'created_at', 'date', 'Date'),
    status: pick(body, 'payment_status', 'Payment_status', 'status', 'Status'),
    remarks: pick(body, 'remarks', 'Remarks'),
    source: 'webhook:wati',
  };
}

export function webhookFingerprint(type: WebhookType, input: IngestInput, body: Record<string, unknown>) {
  const payloadHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return {
    eventId: `${type}:${input.externalTransactionId}:${input.status || 'unknown'}`,
    payloadHash,
  };
}

