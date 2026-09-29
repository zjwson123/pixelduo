// Remove dotenv files from the Next standalone artifact, after every build.
//
// `next build` copies the project's `.env` (and `.env.production`, `.env.local`)
// into `.next/standalone/` unconditionally, so that `node server.js` from that
// directory picks up local configuration. On a build host that is exactly the
// leak: the artifact carries NEXTAUTH_SECRET, DATABASE_URL and the S3 keys in
// cleartext, and a deploy that ships the standalone tree (or a registry image
// built from it, which is why the Dockerfile prunes the same files) hands them
// out with it.
//
// The Docker path already deletes them in both image stages. This is the same
// guard for every path that is NOT Docker, run from the `postbuild` script so a
// plain `npm run build` cannot leave them behind either.
//
// Deleting is safe: nothing in the standalone tree reads a dotenv file at
// runtime once it is gone (Next only loads them as a convenience for local
// runs), and every deployed configuration passes its environment explicitly —
// docker compose, or the host's own process environment.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

// Optional root argument so a test can point this at a scratch tree.
const root = process.argv[2] ?? ".next/standalone";
const removed = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no standalone output (e.g. a build that was interrupted)
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue; // a dependency's own .env is not ours
      walk(p);
    } else if (/^\.env(\.|$)/.test(entry.name)) {
      rmSync(p, { force: true });
      removed.push(p);
    }
  }
}

walk(root);

if (removed.length) {
  const size = removed
    .map((p) => {
      try {
        return statSync(join(p)).size;
      } catch {
        return 0;
      }
    })
    .reduce((a, b) => a + b, 0);
  console.log(
    `[prune-standalone] removed ${removed.length} dotenv file(s) from ${root} (${size} bytes): ${removed.join(", ")}`,
  );
} else {
  console.log(`[prune-standalone] no dotenv files in ${root}`);
}
