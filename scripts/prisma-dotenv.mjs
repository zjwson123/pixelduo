// Neutralise the generated Prisma client's runtime dotenv loading.
//
// The client Prisma generates carries
//   "relativeEnvPaths": { "rootEnvPath": "../../.env", "schemaEnvPath": "../../../.env" }
// resolved against the client's OWN directory, and loads those files when it is
// imported. In the deploy artifact that made a dotenv restored beside the tree
// live configuration for every process that imports the client — including the
// boot gates — while docs/deploy.md said such a file configures nothing
// (pass 38).
//
// Used from two places, because BOTH artifacts carry a generated client:
//   - scripts/prune-standalone.mjs, for the web standalone tree (which `next
//     build` leaves a copied .env inside);
//   - the Dockerfile's worker stage, which runs `npx prisma generate` AFTER its
//     .env prune and therefore regenerates the unpatched shape (pass 39).
//
// The rewrite is exact and fails closed: an unrecognised shape refuses the
// build rather than shipping a client whose dotenv loading silently came back.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const NULL_ENV_PATHS = '"relativeEnvPaths": {"rootEnvPath": null, "schemaEnvPath": null}';

/**
 * @param {string} dir directory containing the generated client's .js files
 * @returns {{state: "ok"|"absent"|"unverifiable", patched?: string[], path?: string}}
 */
export function neuterPrismaDotenv(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { state: "absent" };
  }
  const pattern = /"relativeEnvPaths"\s*:\s*\{[^}]*\}/;
  const patched = [];
  for (const name of names) {
    // index.js is the entry (default.js re-exports it); edge.js and wasm.js
    // carry the same config for runtimes this deployment does not use, and a
    // rewrite that skipped them would leave the claim true only by accident.
    if (!name.endsWith(".js")) continue;
    const p = join(dir, name);
    let src;
    try {
      src = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    if (!src.includes('"relativeEnvPaths"')) continue;
    const match = pattern.exec(src);
    if (!match) {
      // The config exists but not in the shape this rewrite knows. Editing
      // generated code by guesswork could break the client, and leaving it
      // means a .env would be loaded again — so refuse to ship the artifact and
      // let a human look at what Prisma changed.
      return { state: "unverifiable", path: p };
    }
    if (match[0] === NULL_ENV_PATHS) continue;
    writeFileSync(p, src.replace(pattern, NULL_ENV_PATHS));
    patched.push(p);
  }
  return { state: "ok", patched };
}

// CLI: `node scripts/prisma-dotenv.mjs [clientDir]` for the Docker worker stage.
// Imported as a module by prune-standalone.mjs, which applies its own reporting.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const dir = process.argv[2] ?? "node_modules/.prisma/client";
  const result = neuterPrismaDotenv(dir);
  if (result.state === "unverifiable") {
    console.error(
      `[prisma-dotenv] the client at ${result.path} carries a "relativeEnvPaths" block this rewrite does not recognise — refusing to build an artifact whose dotenv loading cannot be neutralised`,
    );
    process.exit(1);
  }
  if (result.state === "absent") {
    console.log(`[prisma-dotenv] no generated client at ${dir} — nothing to neutralise`);
  } else if (result.patched.length === 0) {
    console.log(`[prisma-dotenv] ${dir}: env paths already null`);
  } else {
    console.log(
      `[prisma-dotenv] neutralised the Prisma client's dotenv loading in ${result.patched.length} file(s): ${result.patched.join(", ")}`,
    );
  }
}
