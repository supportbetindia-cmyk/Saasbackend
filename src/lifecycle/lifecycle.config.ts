// Per-tenant lifecycle thresholds. Defaults here; a tenant's saved overrides win.
// SECURITY: these numbers are interpolated into raw SQL (interval '${n} days', LIMIT
// ${n}), so parseLifecycleConfig MUST coerce every field to a bounded positive int.
export const LIFECYCLE_CONFIG = {
  inactiveDays: 30,     // no deposit/withdrawal for this long → INACTIVE
  ftdNoRepeatDays: 7,   // one deposit, no repeat within this → FTD_NO_REPEAT
  cooldownDays: 7,      // don't message the same player again within this
  maxFollowups: 3,      // per stage, then stop until they change stage
};

export type LifecycleConfig = typeof LIFECYCLE_CONFIG;

/** Turn untrusted input into a safe, fully-populated config. Any missing/invalid
 * field falls back to the default; every value is a bounded positive integer. */
export function parseLifecycleConfig(input: unknown): LifecycleConfig {
  const d = LIFECYCLE_CONFIG;
  const o = (input ?? {}) as Record<string, unknown>;
  const posInt = (v: unknown, fallback: number, max: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 && n <= max ? n : fallback;
  };
  return {
    inactiveDays: posInt(o.inactiveDays, d.inactiveDays, 3650),
    ftdNoRepeatDays: posInt(o.ftdNoRepeatDays, d.ftdNoRepeatDays, 3650),
    cooldownDays: posInt(o.cooldownDays, d.cooldownDays, 3650),
    maxFollowups: posInt(o.maxFollowups, d.maxFollowups, 50),
  };
}
