import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthedRequest } from './auth.types';

/** Resolves the active tenant from the `x-tenant-id` header and verifies the
 * authenticated user has an ACTIVE membership in it. Must run after AuthGuard. */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

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
    req.membership = { id: membership.id, role: membership.role, tenantId: membership.tenantId };
    return true;
  }
}
