import { prisma } from "../lib/prisma";
import { ADMIN_GUARD_LOCK } from "../lib/admin-guard";

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
  const user = await prisma.user.findUnique({
    where: { email: e },
    select: { id: true, emailVerified: true },
  });
  if (!user) throw new Error(`user not found: ${e}`);
  // The target is selected by EMAIL, and registration lets anyone create an
  // account for any address with a password of their choosing (verification
  // happens later, and login works before it). Promoting the operator's planned
  // admin address without checking verification therefore handed the admin
  // console to whoever registered that address first: requireAdmin checks only
  // `role`, so an unverified pre-registration became a full operator — including
  // the credit and role routes (pass 43). Verification is what proves the person
  // running this script also controls the mailbox.
  if (role === "admin" && !user.emailVerified) {
    throw new Error(
      `${e} has not verified its email — refusing to grant admin. Verify the account first (or reset it), then re-run`,
    );
  }
  // Count and write are one atomic step under the same lock every admin route
  // uses. This script is the documented recovery path, so two concurrent
  // invocations (or an invocation racing the role route) must not be able to
  // demote the last admin; without the lock both saw two admins and both wrote.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`;
    const current = await tx.user.findUnique({ where: { id: user.id }, select: { role: true } });
    if (!current) throw new Error(`user not found: ${e}`);
    // Refuse to remove the last admin: this script is the only recovery path if
    // the admin UI is unreachable, so locking everyone out of /admin is not
    // something a one-word command should be able to do silently.
    if (role !== "admin" && current.role === "admin") {
      const admins = await tx.user.count({ where: { role: "admin" } });
      if (admins <= 1) {
        throw new Error(`${e} is the only admin — refusing to demote (promote another admin first)`);
      }
    }
    await tx.user.update({ where: { id: user.id }, data: { role } });
  });
  console.log(`[promote-admin] ${e} is now ${role}`);
}

main()
  .catch((e) => {
    console.error("[promote-admin] failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
