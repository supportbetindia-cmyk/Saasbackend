// Generate the three linked secrets a self-hosted Supabase needs:
//   JWT_SECRET        - the HMAC secret GoTrue + PostgREST sign/verify with
//   ANON_KEY          - a long-lived JWT with role "anon"          (frontend NEXT_PUBLIC_SUPABASE_ANON_KEY)
//   SERVICE_ROLE_KEY  - a long-lived JWT with role "service_role"  (server SUPABASE_SERVICE_ROLE_KEY)
//
// ANON_KEY and SERVICE_ROLE_KEY MUST be signed with JWT_SECRET or nothing authenticates.
// Pure Node crypto, no dependencies.  Run:  node gen-keys.mjs
import crypto from 'node:crypto';

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function signJwt(payload, secret) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

const jwtSecret = crypto.randomBytes(32).toString('hex'); // 64 hex chars, well over the 32-char minimum
const iat = Math.floor(Date.now() / 1000);
const exp = iat + 60 * 60 * 24 * 365 * 10; // 10 years
const anon = signJwt({ role: 'anon', iss: 'supabase', iat, exp }, jwtSecret);
const service = signJwt({ role: 'service_role', iss: 'supabase', iat, exp }, jwtSecret);

console.log('# ---- paste these into your Supabase .env ----');
console.log(`JWT_SECRET=${jwtSecret}`);
console.log(`ANON_KEY=${anon}`);
console.log(`SERVICE_ROLE_KEY=${service}`);
console.log(`POSTGRES_PASSWORD=${crypto.randomBytes(18).toString('base64url')}`);
console.log('\n# ---- and into your app env (backend + frontend) ----');
console.log(`SUPABASE_JWT_SECRET=${jwtSecret}`);
console.log(`SUPABASE_SERVICE_ROLE_KEY=${service}`);
console.log(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${anon}`);
