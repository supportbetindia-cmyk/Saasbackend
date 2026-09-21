import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleHasPermission, type PermissionKey } from './permissions';
import type { AuthedRequest } from './auth.types';

export const PERMISSIONS_KEY = 'required_permissions';
/** Decorator: @RequirePermissions('customers.read', ...). Requires TenantGuard first. */
export const RequirePermissions = (...keys: PermissionKey[]) => SetMetadata(PERMISSIONS_KEY, keys);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const role = req.membership?.role;
    if (!role) throw new ForbiddenException('No active tenant membership');

    const ok = required.every((key) => roleHasPermission(role, key));
    if (!ok) throw new ForbiddenException('Insufficient permissions');
    return true;
  }
}
