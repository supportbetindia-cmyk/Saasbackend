import type { PrismaService } from '../prisma/prisma.service';

// Switches on the dashboard's Automations page (public.app_settings, key → 'true'/'false').
export type SwitchKey =
  | 'automation_deposit' | 'automation_withdrawal' | 'campaigns_enabled' | 'winback_enabled';

/** True only if the master switch AND every given switch are on. A switch never touched
 * (no row) counts as on. Fails closed: if the switches can't be read, nothing is sent.
 * ponytail: global switches (app_settings has no tenant_id); per-tenant when a second tenant sends. */
export async function automationAllowed(prisma: PrismaService, ...keys: SwitchKey[]): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
      `select value from public.app_settings where key = any($1::text[])`,
      ['automation_enabled', ...keys],
    );
    return rows.every((r) => String(r.value).toLowerCase() !== 'false');
  } catch {
    return false;
  }
}
