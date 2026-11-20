import fs from "fs";
import path from "path";

// Copy the prototype assets into public/templates for `prisma/seed.ts`.
//
// public/ is served to anonymous visitors (proxy.ts's matcher covers /api and
// the authenticated shells, not static files), and `prisma/seed.ts` is the
// documented quickstart (`npm run db:seed`) that CI also runs. The old loop was
// `readdirSync` + `copyFileSync`, and BOTH ends follow symlinks:
//
//   - a data-only commit that turns a tracked asset into a symlink
//     (`designs/pixelduo/assets/x.png -> ../../../.env`) makes the seed publish
//     the deployment's secrets at https://<host>/templates/x.png. Git records
//     that as mode 120000; no script or config file is touched, so it is easy
//     to miss in review.
//   - a symlink planted at the destination makes copyFileSync open its TARGET
//     with O_TRUNC and overwrite an arbitrary file as the seeding user.
//
// The sibling importer's local-clone path (`scripts/import-case-local.ts`) has
// carried these guards since pass 61. This is the same shape: refuse anything
// but a regular file, open the source with O_NOFOLLOW and decide from the fd's
// own fstat (the lstat→open pair alone is a TOCTOU), reject a hardlink
// (`nlink === 1`), and write through a temp file + rename so an existing
// destination symlink is replaced rather than followed.
export const MAX_TEMPLATE_ASSET_BYTES = 20 * 1024 * 1024;

// A directory that is part of the repository must be a real directory at the
// exact expected path — a symlinked `designs`, `assets`, `public` or
// `templates` sends every later file operation somewhere else.
function assertRealDir(dir: string, expectedReal: string, label: string): void {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${dir}`);
  }
  const actual = fs.realpathSync(dir);
  if (actual !== expectedReal) {
    throw new Error(`${label} resolves outside the repository: ${actual} !== ${expectedReal}`);
  }
}

export function copyTemplateAssets(projectRoot: string = process.cwd()): string[] {
  const rootReal = fs.realpathSync(projectRoot);
  const src = path.join(projectRoot, "designs", "pixelduo", "assets");
  const publicDir = path.join(projectRoot, "public");
  const dst = path.join(publicDir, "templates");

  assertRealDir(src, path.join(rootReal, "designs", "pixelduo", "assets"), "template asset source");

  // `recursive: true` without a symlink check would happily create directories
  // THROUGH a symlinked parent, so create first and then assert the real path.
  fs.mkdirSync(publicDir, { recursive: true });
  assertRealDir(publicDir, path.join(rootReal, "public"), "public directory");
  fs.mkdirSync(dst, { recursive: true });
  assertRealDir(dst, path.join(rootReal, "public", "templates"), "template destination");

  const copied: string[] = [];
  for (const name of fs.readdirSync(src)) {
    // readdir cannot return a path separator, but a hostile entry is refused
    // explicitly rather than relying on that.
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new Error(`unusable template asset name: ${JSON.stringify(name)}`);
    }
    const from = path.join(src, name);
    const before = fs.lstatSync(from);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error(`template asset is not a regular file: ${name}`);
    }

    // O_NOFOLLOW closes the lstat→read swap; the fd's fstat is what decides
    // whether bytes came from the file we inspected.
    const fd = fs.openSync(
      from,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    let bytes: Buffer;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1) {
        throw new Error(`template asset is not a regular single-link file: ${name}`);
      }
      if (opened.size > MAX_TEMPLATE_ASSET_BYTES) {
        throw new Error(`template asset is over the ${MAX_TEMPLATE_ASSET_BYTES}-byte cap: ${name}`);
      }
      bytes = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // Temp + rename: rename replaces a symlink at `to` instead of following it.
    // `created` distinguishes "the temp file exists and needs cleanup" from
    // "the exclusive create failed because something else owns that name".
    const tmp = path.join(
      dst,
      `.${name}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    );
    let created = false;
    try {
      fs.writeFileSync(tmp, bytes, { flag: "wx", mode: 0o644 });
      created = true;
      fs.renameSync(tmp, path.join(dst, name));
      created = false;
    } finally {
      if (created) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // The rename or another actor already removed it.
        }
      }
    }
    copied.push(name);
  }
  return copied;
}
