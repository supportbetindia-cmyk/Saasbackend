import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsEmail, IsEnum } from 'class-validator';
import { MembershipRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentMembership, CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveMembership, ActiveTenant, AuthUser } from '../auth/auth.types';

class InviteMemberDto {
  @IsEmail() email!: string;
  @IsEnum(MembershipRole) role!: MembershipRole;
}

class ChangeRoleDto {
  @IsEnum(MembershipRole) role!: MembershipRole;
}

@Controller('team')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.usersManage)
export class TeamController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get()
  async list(@CurrentTenant() tenant: ActiveTenant) {
    return this.prisma.tenantMembership.findMany({
      where: { tenantId: tenant.id, status: { in: ['ACTIVE', 'INVITED'] } },
      select: { id: true, role: true, status: true, createdAt: true, user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  @Post('invite')
  async invite(
    @CurrentTenant() tenant: ActiveTenant,
    @CurrentUser() actor: AuthUser,
    @CurrentMembership() actorMembership: ActiveMembership,
    @Body() dto: InviteMemberDto,
  ) {
    if (dto.role === 'OWNER' && actorMembership.role !== 'OWNER') throw new BadRequestException('Only an owner can invite another owner');
    const email = dto.email.trim().toLowerCase();
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    const existingMembership = existingUser && await this.prisma.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId: tenant.id, userId: existingUser.id } },
    });
    if (existingMembership) throw new ConflictException('This person is already a team member or has a pending invitation');

    const registered = existingUser && !existingUser.supabaseUserId.startsWith('invite:');
    const membership = await this.prisma.$transaction(async (tx) => {
      const user = existingUser ?? await tx.user.create({ data: { email, supabaseUserId: `invite:${randomUUID()}` } });
      return tx.tenantMembership.create({
        data: { tenantId: tenant.id, userId: user.id, role: dto.role, status: registered ? 'ACTIVE' : 'INVITED' },
        select: { id: true, role: true, status: true, createdAt: true, user: { select: { id: true, email: true, name: true } } },
      });
    });

    const emailSent = registered ? false : await this.sendSupabaseInvite(email);
    await this.audit.log({
      tenantId: tenant.id, actorUserId: actor.id, action: 'team.member.invited', entityType: 'membership', entityId: membership.id,
      newValue: { email, role: dto.role, status: membership.status, emailSent },
    });
    return { ...membership, emailSent };
  }

  @Patch(':id/role')
  async changeRole(
    @Param('id') id: string,
    @CurrentTenant() tenant: ActiveTenant,
    @CurrentUser() actor: AuthUser,
    @CurrentMembership() actorMembership: ActiveMembership,
    @Body() dto: ChangeRoleDto,
  ) {
    const target = await this.membership(tenant.id, id);
    if ((target.role === 'OWNER' || dto.role === 'OWNER') && actorMembership.role !== 'OWNER') throw new BadRequestException('Only an owner can manage owners');
    if (target.role === 'OWNER' && dto.role !== 'OWNER') await this.requireAnotherOwner(tenant.id, id);
    const updated = await this.prisma.tenantMembership.update({ where: { id }, data: { role: dto.role }, include: { user: true } });
    await this.audit.log({ tenantId: tenant.id, actorUserId: actor.id, action: 'team.member.role_changed', entityType: 'membership', entityId: id, oldValue: { role: target.role }, newValue: { role: dto.role } });
    return updated;
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentTenant() tenant: ActiveTenant,
    @CurrentUser() actor: AuthUser,
    @CurrentMembership() actorMembership: ActiveMembership,
  ) {
    const target = await this.membership(tenant.id, id);
    if (target.userId === actor.id) throw new BadRequestException('You cannot remove yourself');
    if (target.role === 'OWNER' && actorMembership.role !== 'OWNER') throw new BadRequestException('Only an owner can remove an owner');
    if (target.role === 'OWNER') await this.requireAnotherOwner(tenant.id, id);
    await this.prisma.tenantMembership.delete({ where: { id } });

    // If this was their last membership anywhere, free the email entirely so it can be
    // invited again: drop the saas.users row AND the GoTrue auth.users record (which is
    // what otherwise makes a re-invite fail with "already registered").
    const remaining = await this.prisma.tenantMembership.count({ where: { userId: target.userId } });
    if (remaining === 0) {
      const user = await this.prisma.user.findUnique({ where: { id: target.userId } });
      await this.prisma.user.delete({ where: { id: target.userId } }).catch(() => undefined);
      if (user) await this.deleteSupabaseUser(user.email);
    }

    await this.audit.log({ tenantId: tenant.id, actorUserId: actor.id, action: 'team.member.removed', entityType: 'membership', entityId: id, oldValue: { userId: target.userId, role: target.role } });
    return { ok: true };
  }

  // Remove the GoTrue auth user by email so the address is fully released. saas.users may
  // only hold an "invite:" placeholder, so resolve the real id from auth.users, then let
  // the admin API delete it (cascades identities/sessions).
  private async deleteSupabaseUser(email: string) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;
    const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `select id::text from auth.users where lower(email) = lower($1) limit 1`, email,
    ).catch(() => [] as { id: string }[]);
    const id = rows[0]?.id;
    if (!id) return;
    await fetch(`${url}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    }).catch(() => undefined);
  }

  private async membership(tenantId: string, id: string) {
    const value = await this.prisma.tenantMembership.findFirst({ where: { id, tenantId } });
    if (!value) throw new NotFoundException('Team member not found');
    return value;
  }

  private async requireAnotherOwner(tenantId: string, excludingId: string) {
    const owners = await this.prisma.tenantMembership.count({ where: { tenantId, role: 'OWNER', status: 'ACTIVE', id: { not: excludingId } } });
    if (!owners) throw new BadRequestException('A company must keep at least one active owner');
  }

  private async sendSupabaseInvite(email: string) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return false;
    const response = await fetch(`${url}/auth/v1/invite`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, redirect_to: `${process.env.DASHBOARD_URL || 'http://localhost:3060'}/saas-login` }),
    });
    return response.ok;
  }
}
