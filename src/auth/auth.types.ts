import type { Request } from 'express';
import type { MembershipRole } from '@prisma/client';

export type AuthUser = { id: string; supabaseUserId: string; email: string; name: string | null };

// masterIds: masters this member may see; empty = all masters.
export type ActiveMembership = { id: string; role: MembershipRole; tenantId: string; masterIds: string[] };
export type ActiveTenant = { id: string; name: string; timezone: string; currency: string };

// Request augmented by the guards.
export interface AuthedRequest extends Request {
  user?: AuthUser;
  tenant?: ActiveTenant;
  membership?: ActiveMembership;
}
