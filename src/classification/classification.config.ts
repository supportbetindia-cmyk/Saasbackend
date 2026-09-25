// Default classification rules. PRD 6.2/6.3 wants these client-configurable "where
// practical" — for V1 they live here as constants; a later admin screen can override
// them per tenant. All amounts are in the tenant currency (INR for BetIndia).

export type ValueTier = { name: string; min: number };

export const CLASSIFICATION_CONFIG = {
  // Days since the last successful deposit that flip an active depositor's stage.
  inactivity: { atRiskDays: 15, inactiveDays: 30 },
  // A depositor becomes a "Regular Player" at this many deposits.
  regularPlayerMinDeposits: 5,
  // Value tiers by lifetime total deposits, highest first. Silver = any depositor
  // below Gold; non-depositors get no tier (blank).
  valueTiers: [
    { name: 'VIP', min: 100000 },
    { name: 'Diamond', min: 50000 },
    { name: 'Platinum', min: 20000 },
    { name: 'Gold', min: 5000 },
    { name: 'Silver', min: 0.01 },
  ] as ValueTier[],
};




export type ClassificationConfig = typeof CLASSIFICATION_CONFIG;

/**
 * Turn user-supplied (untrusted) config into a safe, fully-populated config.
 * SECURITY: tier names and numbers are interpolated into raw SQL in the service,
 * so names are stripped to [A-Za-z0-9 space] and numbers are validated here. Any
 * missing/invalid field falls back to the code default.
 */
export function parseClassificationConfig(input: unknown): ClassificationConfig {
  const d = CLASSIFICATION_CONFIG;
  const o = (input ?? {}) as Record<string, unknown>;
  const posInt = (v: unknown, fallback: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const inact = (o.inactivity ?? {}) as Record<string, unknown>;
  const atRiskDays = posInt(inact.atRiskDays, d.inactivity.atRiskDays);
  const inactiveDays = Math.max(posInt(inact.inactiveDays, d.inactivity.inactiveDays), atRiskDays);
  const tiersIn = Array.isArray(o.valueTiers) ? o.valueTiers : d.valueTiers;
  const valueTiers = (tiersIn as Array<Record<string, unknown>>)
    .map((t) => ({
      name: String(t?.name ?? '').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 24),
      min: Number(t?.min),
    }))
    .filter((t) => t.name.length > 0 && Number.isFinite(t.min) && t.min >= 0)
    .sort((a, b) => b.min - a.min);
  return {
    inactivity: { atRiskDays, inactiveDays },
    regularPlayerMinDeposits: posInt(o.regularPlayerMinDeposits, d.regularPlayerMinDeposits),
    valueTiers: valueTiers.length ? valueTiers : d.valueTiers,
  };
}
