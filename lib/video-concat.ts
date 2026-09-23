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

// The argv, exported so a test can assert the whitelist is present: the flag
// guards a demuxer path (hls/dash segment fetching) that ffmpeg only takes for
// payloads this module refuses before spawning it, so its effect cannot be
// observed end to end — but it must not be dropped in a refactor either.
export function concatFfmpegArgs(listPath: string, outPath: string): string[] {
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
    outPath,
  ];
}

// Concatenates two mp4 clips (original + continuation segment) into one file.
// Returns the output buffer, or null when the input is not mp4, ffmpeg is
// missing, or ffmpeg fails — the caller decides whether segment-only delivery
// is acceptable (it always is: the segment is exactly what the provider billed
// for, and a broken concat must never take down an otherwise-successful job).
export async function concatVideos(a: Buffer, b: Buffer): Promise<Buffer | null> {
  if (!looksLikeIsoBmffMedia(a) || !looksLikeIsoBmffMedia(b)) return null;
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
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        concatFfmpegArgs(listPath, outPath),
        { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return await fsp.readFile(outPath);
  } catch {
    return null;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
