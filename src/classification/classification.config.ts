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
