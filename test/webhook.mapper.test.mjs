import assert from 'node:assert/strict';
import test from 'node:test';
import { mapWebhook } from '../dist/webhooks/webhook.mapper.js';
import { createWebhookSecret, verifyWebhookSecret } from '../dist/webhooks/webhook-secret.js';
import { WebhooksController } from '../dist/webhooks/webhooks.controller.js';

test('maps provider field variants into one transaction input', () => {
  const input = mapWebhook('deposit', {
    User_id: 'player-1', Transaction_id: 'txn-1', Amount: '500',
    Payment_status: 'Approved', User_name: 'Asha', mobile_number: '9876543210',
  });
  assert.deepEqual(input, {
    externalUserId: 'player-1', externalTransactionId: 'txn-1', masterId: null,
    name: 'Asha', phone: '9876543210', transactionType: 'deposit', amount: 500,
    currency: 'INR', occurredAt: null, status: 'Approved', remarks: null,
    source: 'webhook:wati',
  });
});

test('accepts only the generated company webhook secret', () => {
  const companyA = createWebhookSecret();
  const companyB = createWebhookSecret();
  assert.equal(verifyWebhookSecret(companyA.secret, companyA.hash), true);
  assert.equal(verifyWebhookSecret(companyB.secret, companyA.hash), false);
  assert.equal(verifyWebhookSecret('wrong-secret', companyA.hash), false);
});

test('routes a webhook only to the company identified by its key and secret', async () => {
  const companyA = createWebhookSecret();
  const companyB = createWebhookSecret();
  const ingested = [];
  const tenants = {
    'key-a': { id: 'tenant-a', webhookSecretHash: companyA.hash },
    'key-b': { id: 'tenant-b', webhookSecretHash: companyB.hash },
  };
  const prisma = {
    tenant: { findFirst: async ({ where }) => tenants[where.webhookKey] ?? null },
    webhookEvent: { findUnique: async () => null, upsert: async () => ({}) },
  };
  const transactions = { ingest: async (tenantId) => { ingested.push(tenantId); return { id: 'txn-1' }; } };
  const controller = new WebhooksController(prisma, transactions);
  const payload = { User_id: 'player-1', Transaction_id: 'external-1', Amount: '100' };

  await controller.receive('key-a', 'deposit', companyA.secret, payload);
  await assert.rejects(() => controller.receive('key-b', 'deposit', companyA.secret, payload), /Invalid webhook secret/);
  assert.deepEqual(ingested, ['tenant-a']);
});
