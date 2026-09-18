import { prisma } from "../lib/prisma";

// Roles the app recognises. requireAdmin only accepts "admin", so an unchecked
// argument ("owner", "", a typo) wrote a value no code path understands and
// reported success — a silent demotion of the account being promoted.
const ROLES = ["user", "admin"];

// Usage: npx tsx scripts/promote-admin.ts <email> [admin|user]
async function main() {
  const [email, role = "admin"] = process.argv.slice(2);
  if (!email) throw new Error("usage: npx tsx scripts/promote-admin.ts <email> [admin|user]");
  if (!ROLES.includes(role)) {
    throw new Error(`unknown role '${role}' — use one of: ${ROLES.join(", ")}`);
  }
  const e = email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email: e } });
  if (!user) throw new Error(`user not found: ${e}`);
  // Refuse to remove the last admin: this script is the only recovery path if
  // the admin UI is unreachable, so locking everyone out of /admin is not
  // something a one-word command should be able to do silently.
  if (role !== "admin" && user.role === "admin") {
    const admins = await prisma.user.count({ where: { role: "admin" } });
    if (admins <= 1) throw new Error(`${e} is the only admin — refusing to demote (promote another admin first)`);
  }
  await prisma.user.update({ where: { id: user.id }, data: { role } });
  console.log(`[promote-admin] ${e} is now ${role}`);
}

main()
  .catch((e) => {
    console.error("[promote-admin] failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
