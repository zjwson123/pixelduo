import { prisma } from "../lib/prisma";

// Usage: npx tsx scripts/promote-admin.ts <email> [admin|user]
async function main() {
  const [email, role = "admin"] = process.argv.slice(2);
  if (!email) throw new Error("usage: npx tsx scripts/promote-admin.ts <email> [admin|user]");
  const e = email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email: e } });
  if (!user) throw new Error(`user not found: ${e}`);
  await prisma.user.update({ where: { id: user.id }, data: { role } });
  console.log(`[promote-admin] ${e} is now ${role}`);
}

main()
  .catch((e) => {
    console.error("[promote-admin] failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
