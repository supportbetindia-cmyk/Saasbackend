import { BadRequestException, createParamDecorator, ForbiddenException, Injectable, SetMetadata, type ExecutionContext, type PipeTransform } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.types';

/** Master IDs are opaque, case-sensitive strings. Missing/empty means all masters. */
@Injectable()
export class MasterIdPipe implements PipeTransform {
  transform(value: unknown): string | undefined {
    if (value == null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new BadRequestException('masterId must be a single string of at most 128 characters');
    }
    return value.trim() || undefined;
  }
}

/** Marks a route as safe for master-restricted members: it either scopes its data with
 * @MasterId() or exposes no player data. TenantGuard blocks restricted members
 * from every route without it, so new unscoped endpoints are closed by default. */
export const MASTER_SCOPED_KEY = 'master_scoped';
export const MasterScoped = () => SetMetadata(MASTER_SCOPED_KEY, true);

/** The `masterId` query param, enforced against the member's allowed masters:
 * unrestricted → as requested (undefined = all); restricted → must be one of theirs,
 * defaulting to their first when none is requested. */
export function resolveMasterId(raw: unknown, allowed: string[]): string | undefined {
  const requested = new MasterIdPipe().transform(raw);
  if (!allowed.length) return requested;
  if (!requested) return allowed[0];
  if (!allowed.includes(requested)) throw new ForbiddenException('No access to this master');
  return requested;
}

export const MasterId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return resolveMasterId(req.query.masterId, req.membership?.masterIds ?? []);
});

export function customerScope(tenantId: string, masterId?: string) {
  return { tenantId, ...(masterId ? { masterId } : {}) };
}

export function transactionScope(tenantId: string, masterId?: string) {
  return { tenantId, ...(masterId ? { customer: { is: { tenantId, masterId } } } : {}) };
}
