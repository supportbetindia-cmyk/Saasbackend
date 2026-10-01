// Server-side Interakt (WhatsApp Business API) client. Sends pre-approved templates.

const BASE = 'https://api.interakt.ai/v1/public';
const PLACEHOLDER = 'your_interakt_api_key';

export type SendInput = {
  phoneNumber: string; // 10 digits, no country code
  countryCode?: string;
  templateName: string;
  languageCode?: string;
  bodyValues?: string[];
};

/** Send one WhatsApp template message. `apiKey` is the account's Interakt Basic key. */
export async function sendWhatsAppTemplate(input: SendInput, apiKey: string | undefined): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!apiKey || apiKey === PLACEHOLDER) return { ok: false, error: 'Interakt not configured' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${BASE}/message/`, {
      method: 'POST',
      headers: { Authorization: `Basic ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryCode: input.countryCode ?? '+91',
        phoneNumber: input.phoneNumber,
        type: 'Template',
        template: { name: input.templateName, languageCode: input.languageCode ?? 'en', bodyValues: input.bodyValues ?? [] },
      }),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as { result?: boolean; message?: string; id?: string };
    if (!res.ok || json?.result === false) return { ok: false, error: json?.message || `HTTP ${res.status}` };
    return { ok: true, id: json?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'request failed' };
  } finally {
    clearTimeout(timeout);
  }
}

/** Send a free-text WhatsApp "session" message. Only valid inside the 24-hour customer
 * service window (since the customer last messaged us) — outside it, WhatsApp rejects
 * everything but pre-approved templates. Caller must check the window first. */
export async function sendWhatsAppText(
  input: { phoneNumber: string; countryCode?: string; message: string },
  apiKey: string | undefined,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!apiKey || apiKey === PLACEHOLDER) return { ok: false, error: 'Interakt not configured' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${BASE}/message/`, {
      method: 'POST',
      headers: { Authorization: `Basic ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryCode: input.countryCode ?? '+91',
        phoneNumber: input.phoneNumber,
        type: 'Text',
        data: { message: input.message },
      }),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as { result?: boolean; message?: string; id?: string };
    if (!res.ok || json?.result === false) return { ok: false, error: json?.message || `HTTP ${res.status}` };
    return { ok: true, id: json?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'request failed' };
  } finally {
    clearTimeout(timeout);
  }
}
