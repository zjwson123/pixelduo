import { requireVerifiedUser, ok, fail } from "@/lib/api";
import { revokeApiKey } from "@/lib/apikey";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const userId = await requireVerifiedUser();
    const revoked = await revokeApiKey(userId, id);
    if (!revoked) return fail(new Error("invalid-key"));
    return ok({ revoked: true });
  } catch (e) {
    return fail(e);
  }
}
