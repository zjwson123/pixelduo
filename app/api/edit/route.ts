import { z } from "zod";
import { zodMessage, requireVerifiedUser, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped } from "@/lib/api";
import { checkPrompt } from "@/lib/safety";
import { createMediaJob } from "@/lib/queue";
import { getStorage } from "@/lib/storage";
import { saveBase64Image } from "@/lib/store";
import { getImageModels, modelEnum } from "@/lib/model-registry";
import { randomUUID } from "crypto";

const EDITABLE_MODEL_IDS = getImageModels()
  .filter((m) => m.supportsImageInput)
  .map((m) => m.id);

const schema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  model: z.enum(modelEnum(EDITABLE_MODEL_IDS)).default("gpt"),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
  // Reference image as base64 (data URL or raw base64)
  image: z.string().min(100).max(2_000_000), // up to ~2MB base64
  idempotencyKey: z.string().max(128).optional(),
});

// One 2 MB base64 reference plus JSON overhead. This used to be 20 MB to fit
// `extraImages` — a field nothing ever read (the handler only ever used
// element 0, so a client sending 9 images was billed for and received a
// single-image edit while the server buffered ~18 MB of them). Dropping the
// dead field lets the cap come down with it, which is the whole point: this is
// the largest authenticated body in the app.
const EDIT_MAX_BYTES = 4 * 1024 * 1024;

// Data URL prefix, if present. The class must accept "+" (image/svg+xml) and
// friends: with `[a-z]+` a legitimate `data:image/svg+xml;base64,…` did not
// match, so the ENTIRE data URL fell through as "raw base64" and was decoded
// into garbage bytes that were then stored as the reference image (the
// workbench accepts image/*, so an SVG upload is a normal user action).
const DATA_URL_RE = /^data:image\/[\w.+-]+;base64,(.+)$/i;

export async function POST(req: Request) {
  try {
    const userId = await requireVerifiedUser();
    // Account-keyed, before the body is parsed (base64 images make edit bodies
    // the largest surface); the IP-keyed leg it was paired with is gone — see
    // enforceUserRateLimit in lib/api.ts.
    const limited = await enforceUserRateLimit(userId, "edit", 15, 60_000);
    if (limited) return fail(limited);
    const bodyRaw = await readBodyCapped(req, EDIT_MAX_BYTES);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const body = schema.parse(JSON.parse(bodyRaw.raw));
    const safety = checkPrompt(body.prompt);
    if (!safety.ok) return fail(new Error(`blocked:${safety.reason}`));

    // Strip the data URL prefix if present.
    const cleaned = body.image.match(DATA_URL_RE)?.[1] ?? body.image;

    // Store the primary reference image. The write happens BEFORE job creation
    // (the job row must not reference a file that may not exist yet), so any
    // path that doesn't hand the key to a job must delete it — otherwise a
    // zero-credit account fills storage at the route rate limit for free.
    //
    // The stored type comes from the BYTES, not from the data URL's declared
    // media type (or its absence). `newStorageKey("png")` + "image/png" labelled
    // every reference frame a PNG whatever it was: that label is what a presigned
    // URL reports to the provider (which can reject a paid edit call over it) and
    // what /api/files answers for a mid-file Range. Same rule as lib/store.ts's
    // saveRemoteImage/saveBase64Image.
    const storage = getStorage();
    let refKey = "";
    let result: Awaited<ReturnType<typeof createMediaJob>>;
    try {
      refKey = await saveBase64Image(cleaned);
      const key = body.idempotencyKey || `${userId}:edit:${randomUUID()}`;
      result = await createMediaJob({
        userId,
        model: body.model,
        mediaType: "image",
        quality: body.quality,
        count: 1,
        prompt: body.prompt.trim(),
        idempotencyKey: key,
        refImageKey: refKey,
      });
    } catch (e) {
      if (refKey) await storage.delete(refKey).catch(() => undefined);
      throw e;
    }
    if (!result.created) {
      // Idempotent replay returns the ORIGINAL job (with its own ref image);
      // the fresh upload is an orphan — clean it up.
      await storage.delete(refKey).catch(() => undefined);
    }
    return ok({ jobId: result.job.id, status: result.job.status, costCredits: result.job.costCredits, duplicate: !result.created });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
