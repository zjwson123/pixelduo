import { z } from "zod";
import { requirePartialSession, ApiError, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { verifyTotp, useBackupCode, createPreAuthToken } from "@/lib/twofa";

const schema = z
  .object({
    token: z.string().min(6).max(20).optional(),
    backupCode: z.string().min(8).max(40).optional(),
  })
  .refine((v) => Boolean(v.token || v.backupCode), { message: "invalid-input" });

// Second login step: validate TOTP / backup code against the partial session,
// then issue a short-lived single-use ticket that authorize() accepts to
// create the real session.
export async function POST(req: Request) {
  try {
    const limited = await enforceRateLimit(req, "2fa", 5, 60_000);
    if (limited) return limited;
    const su = await requirePartialSession();
    if (!su.totpPending) return fail(new ApiError(403, "2fa-required"));
    const userLimited = await enforceUserRateLimit(su.id, "2fa-verify", 5, 60_000);
    if (userLimited) return fail(userLimited);
    const bodyRaw = await readBodyCapped(req, 8 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const user = await prisma.user.findUnique({
      where: { id: su.id },
      select: { id: true, email: true, totpSecret: true, totpEnabled: true },
    });
    if (!user?.totpEnabled || !user.totpSecret) return fail(new Error("2fa-not-enabled"));

    let ok2 = false;
    if (body.token) ok2 = verifyTotp(user.totpSecret, body.token);
    else if (body.backupCode) ok2 = await useBackupCode(user.id, body.backupCode);
    if (!ok2) return fail(new Error("invalid-code"));

    const preAuthToken = await createPreAuthToken(user.email);
    return ok({ preAuthToken });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(new Error("invalid-input"));
    return fail(e);
  }
}
