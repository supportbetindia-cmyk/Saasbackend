import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { MASTER_SCOPED_KEY } from '../customers/master-scope';
import type { AuthedRequest } from './auth.types';

/** Resolves the active tenant from the `x-tenant-id` header and verifies the
 * authenticated user has an ACTIVE membership in it. Must run after AuthGuard. */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new UnauthorizedException();

    const tenantId = req.headers['x-tenant-id'];
    if (!tenantId || typeof tenantId !== 'string') throw new BadRequestException('Missing x-tenant-id header');

    const membership = await this.prisma.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId, userId: req.user.id } },
      include: { tenant: true },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new ForbiddenException('No access to this tenant');
    }

    req.tenant = {
      id: membership.tenant.id,
      name: membership.tenant.name,
      timezone: membership.tenant.timezone,
      currency: membership.tenant.currency,
    };
    req.membership = {
      id: membership.id, role: membership.role, tenantId: membership.tenantId,
      // Owners are never master-restricted, so a company can't lock itself out.
      masterIds: membership.role === 'OWNER' ? [] : membership.masterIds,
    };

    // Master-restricted members may only use routes that scope data by master
    // (@MasterScoped); everything else is closed to them by default.
    const scoped = this.reflector.getAllAndOverride<boolean>(MASTER_SCOPED_KEY, [context.getHandler(), context.getClass()]);
    if (req.membership.masterIds.length && !scoped) {
      throw new ForbiddenException('Your access is limited to specific masters');
    }
    return true;
  }
}
