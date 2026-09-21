import { Controller, Get, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';

@Controller('me')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async me(@CurrentUser() user: AuthUser) {
    const memberships = await this.prisma.tenantMembership.findMany({
      where: { userId: user.id, status: 'ACTIVE' },
      include: { tenant: true },
    });
    return {
      user,
      tenants: memberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name, role: m.role })),
    };
  }
}
