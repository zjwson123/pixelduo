import fs from "fs";
import path from "path";

// Local-clone helpers for scripts/import-cases.ts, kept in their own module so
// a unit test can exercise them without importing the script (which runs main()
// at module load and owns a PrismaClient).
//
// The script's instructions tell the operator to clone a THIRD-PARTY repository
// to a fixed path and read images from it. `O_NOFOLLOW` on the final component
// rejects a symlinked case image, but the kernel resolves intermediate
// components: a cloned `data/images` that is itself a symlink (for example to
// the importer's repository root, or to /proc/self/cwd) made
// `data/images/.env` a regular file one level below the checked path. The bytes
// were stored as an object and registered as a Template whose image /api/files
// serves to any signed-in account — publishing NEXTAUTH_SECRET, DATABASE_URL
// and the provider keys.
//
// The fix is to resolve the DIRECTORY and require it to be exactly
// <real clone root>/data/images. A symlinked `data`, a symlinked `images`, or
// an escape to another tree all fail that equality and fall back to the GitHub
// download path.
export function resolveLocalImagesDir(cloneRoot: string): string | null {
  const imagesPath = path.join(cloneRoot, "data", "images");
  try {
    // lstat first: realpath() on a symlink would happily return its target.
    const stat = fs.lstatSync(imagesPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    const rootReal = fs.realpathSync(cloneRoot);
    const expected = path.join(rootReal, "data", "images");
    const actual = fs.realpathSync(imagesPath);
    return actual === expected ? actual : null;
  } catch {
    // Missing clone is the ordinary "use the network" path.
    return null;
  }
}

// A case entry names "/images/caseN.jpg"; only a bare filename may be joined to
// the validated directory. `..` and an embedded separator are refused rather
// than normalised, so a hostile cases.json cannot address a parent path.
export function safeCaseFilename(srcPath: string): string | null {
  const name = path.basename(srcPath);
  if (!name || name === "." || name === "..") return null;
  if (name.includes("/") || name.includes("\\") || name.includes("\u0000")) return null;
  return name;
}
