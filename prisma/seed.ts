// Seed a first tenant (BetIndia). Run after migrations: `npm run seed`.
// Owner user is linked once a real Supabase user logs in and is granted membership;
// for now we just ensure the tenant exists.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.tenant.findFirst({ where: { name: 'BetIndia' } });
  if (existing) {
    console.log('BetIndia tenant already exists:', existing.id);
    return;
  }
  const tenant = await prisma.tenant.create({
    data: { name: 'BetIndia', timezone: 'Asia/Kolkata', currency: 'INR' },
  });
  console.log('Created BetIndia tenant:', tenant.id);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
