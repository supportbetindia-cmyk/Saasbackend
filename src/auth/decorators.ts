import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthedRequest, AuthUser, ActiveTenant, ActiveMembership } from './auth.types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user
);

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ActiveTenant | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().tenant
);

export const CurrentMembership = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ActiveMembership | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().membership
);
