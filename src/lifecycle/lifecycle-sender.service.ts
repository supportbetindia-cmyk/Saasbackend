import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../whatsapp/message';
import { sendWhatsAppTemplate } from '../whatsapp/interakt';
import { LifecycleService } from './lifecycle.service';

// Which Interakt template each stage sends (the doc's primary template per stage).
// ACTIVE is null = we don't auto-market active players by default. A tenant can
// override any of these via its retention account's templates (keyed by stage).
const STAGE_TEMPLATES: Record<string, string | null> = {
  LEAD: 'lead_get_started',
  REGISTERED_NO_FTD: 'first_deposit_offer',
  FTD: 'first_deposit_welcome',
  FTD_NO_REPEAT: 'experience_check_in',
  ACTIVE: null,
  INACTIVE: 'inactive_user_check_in',
  REACTIVATED: 'welcome_back',
};

const CAP = 200;                // per stage per run (deliverability); not user-tunable

export type StageResult = { stage: string; template: string; eligible: number; sent: number; failed: number; skipped: number };

type Candidate = { id: string; name: string | null; phone: string | null; userId: string | null };

@Injectable()
export class LifecycleSenderService {
  private readonly log = new Logger('Lifecycle');
  constructor(private readonly prisma: PrismaService, private readonly lifecycle: LifecycleService) {}

  /** The retention account's key + optional per-stage template overrides. Gated on
   * the account being ENABLED — that checkbox is the on/off switch. */
  private async config(tenantId: string): Promise<{ apiKey?: string; templates: Record<string, string>; lang: string }> {
    const envKey = process.env.INTERAKT_CAMPAIGN_API_KEY || process.env.INTERAKT_API_KEY;
    const lang = process.env.WINBACK_LANG || 'en';
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ api_key: string | null; templates: Record<string, string> | null }[]>(
        `select api_key, templates from public.whatsapp_settings
          where tenant_id = $1::uuid and enabled = true and api_key is not null and api_key <> ''
            and role ~* 'retention|camp'
          order by (role = 'retention') desc limit 1`,
        tenantId,
      );
      const row = rows[0];
      if (!row) return { apiKey: undefined, templates: {}, lang };
      return { apiKey: row.api_key || envKey, templates: row.templates ?? {}, lang };
    } catch {
      return { apiKey: undefined, templates: {}, lang };
    }
  }

  /** Customers in a stage who pass every suppression rule and are due a message.
   * cooldownDays/maxFollowups come from the tenant's (validated) config. */
  private async eligible(tenantId: string, stage: string, cooldownDays: number, maxFollowups: number): Promise<Candidate[]> {
    return this.prisma.$queryRawUnsafe<Candidate[]>(
      `select id, name, phone, external_user_id as "userId"
       from saas.customers
       where tenant_id = $1
         and current_stage = $2
         and phone is not null and phone <> ''
         and marketing_opt_out = false
         and support_issue_open = false
         and follow_up_count < ${maxFollowups}
         and (last_template_sent_at is null or last_template_sent_at < now() - interval '${cooldownDays} days')
       order by last_template_sent_at asc nulls first
       limit ${CAP}`,
      tenantId, stage,
    );
  }

  /** Send one stage's template to its eligible customers. */
  async sendStage(tenantId: string, stage: string, apiKey: string, templateName: string, lang: string, cooldownDays: number, maxFollowups: number): Promise<StageResult> {
    const players = await this.eligible(tenantId, stage, cooldownDays, maxFollowups);
    let sent = 0, failed = 0, skipped = 0;
    for (const p of players) {
      const phone = normalizePhone(p.phone ?? '');
      if (!phone) { skipped++; continue; }
      const eventKey = createHash('sha256')
        .update(`lifecycle|${stage}|${tenantId}|${p.userId || phone.phoneNumber}|${new Date().toISOString().slice(0, 10)}`)
        .digest('hex');

      // payload.send is the replay envelope the retry worker uses if this send fails.
      const payload = JSON.stringify({
        send: { countryCode: phone.countryCode, languageCode: lang, bodyValues: [p.name || 'there'], role: 'retention' },
      });
      const claimed = await this.prisma.$executeRawUnsafe(
        `insert into public.message_log (event_key, channel, template, event_type, mobile, user_id, payload, status, tenant_id)
         values ($1,'whatsapp',$2,$3,$4,$5,$6::jsonb,'queued',$7::uuid)
         on conflict (event_key) do nothing`,
        eventKey, templateName, `lifecycle:${stage}`, phone.phoneNumber, p.userId ?? null, payload, tenantId,
      );
      if (claimed === 0) { skipped++; continue; }

      const res = await sendWhatsAppTemplate(
        { phoneNumber: phone.phoneNumber, countryCode: phone.countryCode, templateName, languageCode: lang, bodyValues: [p.name || 'there'] },
        apiKey,
      );
      if (res.ok) {
        sent++;
        await this.prisma.$executeRawUnsafe(
          `update public.message_log set status='sent', sent_at=now(), provider_message_id=$2, updated_at=now() where event_key=$1`,
          eventKey, res.id ?? null,
        );
        // Advance the customer's send state: cooldown clock + follow-up count.
        await this.prisma.$executeRawUnsafe(
          `update saas.customers set follow_up_count = follow_up_count + 1,
             last_template_sent = $2, last_template_sent_at = now(), updated_at = now()
           where id = $1`,
          p.id, templateName,
        );
      } else {
        failed++;
        await this.prisma.$executeRawUnsafe(
          `update public.message_log set status='failed', last_error=$2, attempt_count=attempt_count+1,
             next_attempt_at=now() + interval '2 minutes', updated_at=now() where event_key=$1`,
          eventKey, res.error ?? 'send failed',
        );
      }
    }
    return { stage, template: templateName, eligible: players.length, sent, failed, skipped };
  }

  /** Run all stages for a tenant: resolve each stage's template, send, aggregate. */
  async runTenant(tenantId: string): Promise<{ configured: boolean; results: StageResult[] }> {
    const { apiKey, templates, lang } = await this.config(tenantId);
    if (!apiKey) return { configured: false, results: [] };
    const cfg = await this.lifecycle.getConfig(tenantId);

    const results: StageResult[] = [];
    for (const [stage, defaultTemplate] of Object.entries(STAGE_TEMPLATES)) {
      const templateName = templates[stage] || defaultTemplate; // tenant override, else default
      if (!templateName) continue; // ACTIVE (null) or nothing configured → skip
      const r = await this.sendStage(tenantId, stage, apiKey, templateName, lang, cfg.cooldownDays, cfg.maxFollowups);
      if (r.sent || r.failed) {
        this.log.log(`${tenantId} ${stage}: sent ${r.sent}, failed ${r.failed} (${templateName})`);
      }
      results.push(r);
    }
    return { configured: true, results };
  }

  /** Eligible counts per stage, no sending (for the UI). */
  async preview(tenantId: string): Promise<{ configured: boolean; stages: { stage: string; template: string | null; eligible: number }[] }> {
    const { apiKey, templates } = await this.config(tenantId);
    const cfg = await this.lifecycle.getConfig(tenantId);
    const stages = [];
    for (const [stage, defaultTemplate] of Object.entries(STAGE_TEMPLATES)) {
      const template = templates[stage] || defaultTemplate;
      const eligible = template ? (await this.eligible(tenantId, stage, cfg.cooldownDays, cfg.maxFollowups)).length : 0;
      stages.push({ stage, template, eligible });
    }
    return { configured: Boolean(apiKey), stages };
  }
}
