import { execFile } from "child_process";
import fsp from "fs/promises";
import os from "os";
import path from "path";

// Both inputs are provider-controlled bytes (the segment is downloaded from the
// generation provider; the source clip is an earlier one), and ffmpeg's concat
// demuxer opens each listed file with FORMAT AUTODETECTION — the `-f concat`
// applies to our list file, not to the entries it names. A payload that probes
// as a playlist/xml demuxer is therefore a second egress path that never passes
// through fetchPublicBuffer's DNS-pinned agent, in a container with no port
// allowlist. Measured on the platform ffmpeg (7.1.1, `probe3/probe4`):
//   - an HLS playlist IS selected as `hls` and fetches its segment URI — but
//     only when the file is named `*.m3u8` (extension-matched). As `b.mp4` the
//     same bytes are refused outright ("Invalid data found").
//   - a `<MPD>` payload is not selected as `dash` unless it carries a stronger
//     marker, and likewise not as `.mp4`.
// So the concrete vector is not reachable through the names this function
// writes — the guards below exist so that stays true if the names, the ffmpeg
// version or the heuristics ever change, and because "concatenate two mp4s" is
// a contract we can state and check rather than infer from a parser.
function looksLikeIsoBmffMedia(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  // A top-level ISO-BMFF box: 4-byte big-endian size, then a 4-character type.
  // Tolerant on which box comes first (ftyp normally, but wide/free/moov/styp
  // are legal openers) — strict enough that no playlist, XML or text payload
  // can pass: those begin with `#`, `<`, `{`, `[` or a byte that is not ASCII.
  return [
    "ftyp", "styp", "moov", "mdat", "free", "skip", "wide", "uuid",
  ].includes(buf.subarray(4, 8).toString("latin1"));
}

export { looksLikeIsoBmffMedia };

// Ceiling on what one concat may hand back, and the reason it exists: both
// INPUTS are capped (100 MB each in lib/store's fetchPublicBuffer) and the output
// was not — no `-fs`, no stat, and the whole file read into one Buffer in the
// worker process that serves every other job. A provider (or a hostile segment)
// returning 15 s of cheap high-frequency noise expands several-fold under the
// `-crf 20` re-encode, and the only thing bounding it was the 180 s ffmpeg
// timeout — which bounds time, not bytes. 512 MB container, one job OOMs the
// worker, every other in-flight job retries and re-bills.
export const CONCAT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

// Generous by design — the number that matters is that there IS one. 4x the
// inputs covers the noise case (where a cheap low-bitrate source legitimately
// grows), the 64 MB floor keeps short clips comfortable, and the absolute cap
// keeps the worker's heap bounded whatever the inputs claim.
export function concatOutputLimit(inputBytes: number): number {
  return Math.min(CONCAT_MAX_OUTPUT_BYTES, Math.max(64 * 1024 * 1024, inputBytes * 4));
}

// The argv, exported so a test can assert the whitelist is present: the flag
// guards a demuxer path (hls/dash segment fetching) that ffmpeg only takes for
// payloads this module refuses before spawning it, so its effect cannot be
// observed end to end — but it must not be dropped in a refactor either.
export function concatFfmpegArgs(
  listPath: string,
  outPath: string,
  maxBytes: number = CONCAT_MAX_OUTPUT_BYTES,
): string[] {
  return [
    "-y",
    // Inherited by every demuxer the entries above open (that is how ffmpeg
    // propagates it), so no nested playlist, segment or manifest can reach the
    // network from inside the worker container. The inputs are local files and
    // nothing a real mp4 needs requires more.
    "-protocol_whitelist", "file,crypto,data",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-c:v", "libx264", "-preset", "fast", "-crf", "20",
    "-c:a", "aac", "-movflags", "+faststart",
    // Stop writing at the cap instead of filling the disk (and the heap) first.
    "-fs", String(maxBytes),
    outPath,
  ];
}

// Ceiling on the two INPUTS together, checked before anything is written to
// disk. Each input is capped on its own upstream (100 MB per download,
// lib/providers) but the peak the worker holds is len(a) + len(b) + the output
// buffer, and a chained source is a previous concat output — up to the 256 MB
// output cap — so the per-object caps bound nothing: worst case was ~600 MB
// inside a 512 MB container, and the output cap cannot help because the inputs
// are already resident when it is computed (the source is a Buffer from the
// store, the segment a Buffer from the provider). A refusal is a graceful
// degradation here, not an error: the caller ships the segment alone, which is
// exactly what the provider billed for.
export const CONCAT_MAX_INPUT_BYTES = 320 * 1024 * 1024;

export function concatInputsWithinBudget(aBytes: number, bBytes: number): boolean {
  return aBytes + bBytes <= CONCAT_MAX_INPUT_BYTES;
}

// Concatenates two mp4 clips (original + continuation segment) into one file.
// Returns the output buffer, or null when the inputs are not mp4, exceed the
// combined budget, ffmpeg is missing, or ffmpeg fails — the caller decides
// whether segment-only delivery is acceptable (it always is: the segment is
// exactly what the provider billed for, and a broken concat must never take
// down an otherwise-successful job).
export async function concatVideos(a: Buffer, b: Buffer): Promise<Buffer | null> {
  if (!looksLikeIsoBmffMedia(a) || !looksLikeIsoBmffMedia(b)) return null;
  if (!concatInputsWithinBudget(a.length, b.length)) return null;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pdconcat-"));
  try {
    const aPath = path.join(dir, "a.mp4");
    const bPath = path.join(dir, "b.mp4");
    const listPath = path.join(dir, "list.txt");
    const outPath = path.join(dir, "out.mp4");
    await fsp.writeFile(aPath, a);
    await fsp.writeFile(bPath, b);
    // -safe 0: the paths are ours (mkdtemp), not user input.
    await fsp.writeFile(listPath, `file '${aPath}'\nfile '${bPath}'\n`);
    // Re-encode rather than -c copy: both clips come from the same model, but
    // encoder parameters can differ between generations and a copy-concat of
    // mismatched streams produces a file that some players refuse to play.
    const limit = concatOutputLimit(a.length + b.length);
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        concatFfmpegArgs(listPath, outPath, limit),
        { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    // `-fs` stops ffmpeg mid-file, so an output at (or past) the cap is a
    // truncated clip, not a deliverable one: refuse it and let the caller ship
    // the segment it was billed for.
    const { size } = await fsp.stat(outPath);
    if (size >= limit) return null;
    return await fsp.readFile(outPath);
  } catch {
    return null;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
