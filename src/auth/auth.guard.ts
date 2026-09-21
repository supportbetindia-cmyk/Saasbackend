import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { verifySupabaseJwt } from './jwt.util';
import type { AuthedRequest } from './auth.types';

/** Verifies the Supabase access token and ensures a local `users` row exists
 * (linked by supabase_user_id), attaching it to the request as `user`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('Missing bearer token');

    let claims;
    try {
      claims = await verifySupabaseJwt(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const supabaseUserId = String(claims.sub);
    const email = (claims.email ?? `${supabaseUserId}@unknown.local`).toLowerCase();

    const user = await this.prisma.user.upsert({
      where: { supabaseUserId },
      update: { email },
      create: { supabaseUserId, email },
    });

    req.user = { id: user.id, supabaseUserId: user.supabaseUserId, email: user.email, name: user.name };
    return true;
  }
}
