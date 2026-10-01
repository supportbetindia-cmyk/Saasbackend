import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard } from '../auth/tenant.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentTenant, CurrentUser } from '../auth/decorators';
import type { ActiveTenant, AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { InboxService } from './inbox.service';

@Controller('inbox')
@UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.whatsappRead)
  list(@CurrentTenant() tenant: ActiveTenant) {
    return this.inbox.list(tenant.id);
  }

  @Get(':customerId')
  @RequirePermissions(PERMISSIONS.whatsappRead)
  thread(@CurrentTenant() tenant: ActiveTenant, @Param('customerId') customerId: string) {
    return this.inbox.thread(tenant.id, customerId);
  }

  @Post(':customerId/reply')
  @RequirePermissions(PERMISSIONS.whatsappManage)
  async reply(
    @CurrentTenant() tenant: ActiveTenant,
    @CurrentUser() user: AuthUser,
    @Param('customerId') customerId: string,
    @Body() body: { text?: string },
  ) {
    const result = await this.inbox.reply(tenant.id, customerId, body?.text ?? '');
    await this.audit.log({
      tenantId: tenant.id, actorUserId: user.id, action: 'inbox.replied',
      entityType: 'customer', entityId: customerId,
    });
    return result;
  }
}
