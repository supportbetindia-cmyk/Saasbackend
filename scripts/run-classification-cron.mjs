const base = (process.env.BACKEND_PUBLIC_URL || '').replace(/\/$/, '');
const secret = process.env.CRON_SECRET;
if (!base || !secret) throw new Error('BACKEND_PUBLIC_URL and CRON_SECRET are required');

const response = await fetch(`${base}/api/v1/cron/classification`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${secret}` },
});
const body = await response.text();
if (!response.ok) throw new Error(`Classification cron failed (${response.status}): ${body}`);
console.log(body);
