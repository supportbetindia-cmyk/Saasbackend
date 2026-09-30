import type { PrismaService } from '../prisma/prisma.service';

// Which Interakt account a message was sent from. We store this on the log row so a
// retry knows which key to re-send with — 'updates' = transaction account,
// 'retention' = the lifecycle/campaign account.
export type SendRole = 'updates' | 'retention';

/** Resolve a tenant's Interakt Basic key for a role, falling back to env. Mirrors the
 * lookup in whatsapp.service.config() / lifecycle-sender.config() so retries pick the
 * same key the original send used. */
export async function resolveInteraktKey(
  prisma: PrismaService,
  tenantId: string,
  role: SendRole,
): Promise<string | undefined> {
  const envKey =
    role === 'retention'
      ? process.env.INTERAKT_CAMPAIGN_API_KEY || process.env.INTERAKT_API_KEY
      : process.env.INTERAKT_API_KEY;
  try {
    // role is our own constant (never user input), so interpolating it is safe.
    const roleMatch = role === 'retention' ? `role ~* 'retention|camp'` : `role = 'updates'`;
    const rows = await prisma.$queryRawUnsafe<{ api_key: string | null }[]>(
      `select api_key from public.whatsapp_settings
        where tenant_id = $1::uuid and enabled = true and api_key is not null and api_key <> ''
          and ${roleMatch}
        limit 1`,
      tenantId,
    );
    return rows[0]?.api_key || envKey;
  } catch {
    return envKey;
  }
}
