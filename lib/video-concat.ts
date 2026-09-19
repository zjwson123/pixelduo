import { execFile } from "child_process";
import fsp from "fs/promises";
import os from "os";
import path from "path";

// Concatenates two mp4 clips (original + continuation segment) into one file.
// Returns the output buffer, or null when ffmpeg is missing or fails — the
// caller decides whether segment-only delivery is acceptable (it always is:
// the segment is exactly what the provider billed for, and a broken concat
// must never take down an otherwise-successful job).
export async function concatVideos(a: Buffer, b: Buffer): Promise<Buffer | null> {
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
        [
          "-y", "-f", "concat", "-safe", "0", "-i", listPath,
          "-c:v", "libx264", "-preset", "fast", "-crf", "20",
          "-c:a", "aac", "-movflags", "+faststart",
          outPath,
        ],
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
