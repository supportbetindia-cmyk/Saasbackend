import { Global, Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { TenantGuard } from './tenant.guard';
import { PermissionsGuard } from './permissions.guard';

// Global so any controller can @UseGuards(AuthGuard, TenantGuard, PermissionsGuard)
// with DI (PrismaService comes from the global PrismaModule).
@Global()
@Module({
  providers: [AuthGuard, TenantGuard, PermissionsGuard],
  exports: [AuthGuard, TenantGuard, PermissionsGuard],
})
export class AuthModule {}
