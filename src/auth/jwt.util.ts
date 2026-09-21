import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
} from 'jose';

export type SupabaseClaims = JWTPayload & { email?: string; phone?: string; role?: string };

let remoteJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let remoteJwksUrl: string | null = null;

function getSupabaseUrl(): string {
  const value = process.env.SUPABASE_URL?.replace(/\/$/, '');
  if (!value) throw new Error('SUPABASE_URL is not set');
  return value;
}

function getRemoteJwks() {
  const url = `${getSupabaseUrl()}/auth/v1/.well-known/jwks.json`;
  if (!remoteJwks || remoteJwksUrl !== url) {
    remoteJwks = createRemoteJWKSet(new URL(url));
    remoteJwksUrl = url;
  }
  return remoteJwks;
}

/** Verify either a modern Supabase signing-key token or a legacy HS256 token. */
export async function verifySupabaseJwt(token: string): Promise<SupabaseClaims> {
  const { alg } = decodeProtectedHeader(token);
  const issuer = `${getSupabaseUrl()}/auth/v1`;
  let payload: JWTPayload;

  if (alg === 'HS256') {
    const secretStr = process.env.SUPABASE_JWT_SECRET;
    if (!secretStr) throw new Error('SUPABASE_JWT_SECRET is not set for legacy HS256 verification');
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secretStr), {
      algorithms: ['HS256'],
      issuer,
      audience: 'authenticated',
    }));
  } else {
    ({ payload } = await jwtVerify(token, getRemoteJwks(), {
      algorithms: ['RS256', 'ES256', 'EdDSA'],
      issuer,
      audience: 'authenticated',
    }));
  }

  if (!payload.sub) throw new Error('Token missing sub');
  return payload as SupabaseClaims;
}
