#!/usr/bin/env tsx
// Deployment-configuration coherence check.
//
// The recurring bug class in this repo is a variable that is DOCUMENTED in
// .env.example, READ by the code, and FORWARDED BY NO COMPOSE ANCHOR — so it
// never reaches a container and the deployment quietly runs with a default
// (DEEPSEEK_BASE_URL, VISION_MODERATION_*, IMAGE_NSFW_ENDPOINT, DASHSCOPE_API_KEY,
// SENTRY_RELEASE, MODELVERSE_IMAGE_API_KEY …). It has produced a real finding in
// every security pass for months, because reading the three files side by side is
// exactly the work nobody does when adding a knob. This script does it.
//
// How it reads the compose files: `docker compose config --format json`, not a
// hand-rolled YAML parse. That is the AUTHORITATIVE answer — it resolves anchors
// (`&appenv`), aliases (`<<: *appenv`), flow maps and `:?` interpolation — and it
// validates that each file actually parses. Required variables are satisfied from
// a generated fixture, discovered by re-running with the names compose names in
// its own error messages.
//
//   npx tsx scripts/check-config.ts
//
// Exits 1 on a violation. Docker is required for the compose half; without it the
// compose assertions are skipped with a warning (a dev machine without docker can
// still run the .env.example half).
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const ROOT = process.cwd();
const BUILD_ARG_REASON =
  "a BUILD-time value: docker-compose.prod.yml only names the image, the build runs from the default file";
const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.prod.yml",
  "docker-compose.single.yml",
];
const ENV_EXAMPLE = ".env.example";

// Names a compose file legitimately forwards without .env.example documenting
// them: they wire one container to its neighbour's own configuration, they are
// not operator knobs. Each needs a reason — the point of this file.
const INTERNAL_FORWARDED: Record<string, string> = {
  MINIO_ROOT_USER: "minio/minio server's own credential name (fed from S3_ACCESS_KEY_ID)",
  MINIO_ROOT_PASSWORD: "minio/minio server's own credential name (fed from S3_SECRET_ACCESS_KEY)",
  PGHOST: "postgres client's own variable, set from the service hostname",
  PGPORT: "postgres client's own variable",
  PGUSER: "postgres client's own variable (fed from POSTGRES_USER)",
  PGPASSWORD: "postgres client's own variable (fed from POSTGRES_PASSWORD)",
  PGDATABASE: "postgres client's own variable",
  REDISCLI_AUTH: "redis-cli's own auth variable, fed from REDIS_PASSWORD for the healthcheck (pass 27 — the `-a` flag put the password in the probe's argv)",
  BACKUP_S3_ENDPOINT: "the backup service's own source-bucket wiring",
  BACKUP_S3_ACCESS_KEY_ID: "the backup service's own source-bucket wiring",
  BACKUP_S3_SECRET_ACCESS_KEY: "the backup service's own source-bucket wiring",
  BACKUP_S3_BUCKET: "the backup service's own source-bucket wiring",
  CADDY_DOMAIN: "read by the Caddyfile, not by the app (docs/deploy.md sets it)",
  HOSTNAME: "Docker/Node runtime variable, pinned to 0.0.0.0",
  NODE_ENV: "runtime variable set by the image",
};

// Names the app reads that are deliberately NOT forwarded by every compose file,
// with the reason. A name whose only entry here is a subset of files is allowed
// to be missing from exactly those files.
const NOT_FORWARDED: Record<string, { files: string[]; reason: string }> = {
  // Build-time-only variables. docker-compose.prod.yml has no build: blocks at
  // all (it names images), so the build args that carry these live in the
  // default file; a prod build is `docker compose build` from there.
  NEXT_PUBLIC_SENTRY_DSN: { files: ["docker-compose.prod.yml"], reason: BUILD_ARG_REASON },
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: { files: ["docker-compose.prod.yml"], reason: BUILD_ARG_REASON },
  NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: {
    files: ["docker-compose.prod.yml"],
    reason: BUILD_ARG_REASON,
  },
  // Forwarded by NO file, deliberately: an image build must not receive this as
  // a build argument (ARG values are recorded in the image history and in every
  // `docker save` tarball — verified), and nothing consumed it anyway, because
  // next.config.mjs gates the Sentry wrapper on SENTRY_DSN, which no build sets.
  // Wiring source-map upload means a BuildKit secret mount, not an anchor here.
  SENTRY_AUTH_TOKEN: {
    files: COMPOSE_FILES,
    reason:
      "a build ARG that would leak the token into the image history, and the upload it enabled was never wired (see the Dockerfile note). Use a BuildKit secret if symbolication is wanted.",
  },
  LOCAL_STORAGE_DIR: {
    files: COMPOSE_FILES,
    reason:
      "the container stacks pin STORAGE_DRIVER=s3; a container-local filesystem is the bug (see docker-compose.yml)",
  },
  MAIL_DEV_DIR: {
    files: COMPOSE_FILES,
    reason:
      "writes each dev mail to a file for e2e specs; the container stacks forward MAIL_DEV_MODE instead",
  },
  // PAYMENT_ALLOW_MOCK is the one escape hatch that really is local-only: the
  // default compose sets it to 1 for the mock flow, and neither prod file
  // forwards it at all (a deployment that sets it in its own .env is opt-ing in
  // through compose interpolation, not through an anchor line here). The other
  // three — EMAIL_VERIFY_AUTO, TRUST_X_REAL_IP, MAIL_DEV_MODE — DO carry anchors
  // in both prod files, so an exemption for them would only un-protect those
  // anchors; check 2b fails on exactly that.
  PAYMENT_ALLOW_MOCK: {
    files: ["docker-compose.prod.yml", "docker-compose.single.yml"],
    reason: "a boot-assertion escape hatch for the local/test stack only",
  },
  // NEXTAUTH_URL deliberately has no entry: all three files forward it (as an
  // env var and as a build arg), so any exemption here would be dead weight that
  // silences the one check that matters most on this variable.
};

function readEnvExample(): { keys: Set<string>; duplicates: string[] } {
  const keys = new Set<string>();
  const duplicates: string[] = [];
  const text = fs.readFileSync(path.join(ROOT, ENV_EXAMPLE), "utf8");
  for (const line of text.split("\n")) {
    // Commented-out assignments count as documented (several optional knobs —
    // OAuth credentials, OUTBOUND_TIMEOUT_MS — ship that way on purpose), but
    // the value must LOOK like a value: prose that merely mentions
    // "STORAGE_DRIVER=local" in a sentence is not an assignment.
    const m = /^#?\s*([A-Z][A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|\S*)\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    if (keys.has(m[1])) duplicates.push(m[1]);
    keys.add(m[1]);
  }
  return { keys, duplicates };
}

/** Every process.env.NAME read in code that ships in an image. */
function codeReadNames(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const roots = ["app", "lib", "scripts", "components", "prisma"];
  const singles = [
    "proxy.ts",
    "instrumentation.ts",
    "instrumentation-client.ts",
    "next.config.mjs",
    "sentry.server.config.ts",
    "sentry.edge.config.ts",
  ];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(p);
      } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) files.push(p);
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);
  for (const s of singles) if (fs.existsSync(s)) files.push(s);
  for (const f of files) {
    if (f.endsWith("scripts/check-config.ts")) continue; // its own doc comment
    const src = fs.readFileSync(f, "utf8");
    // Two idioms read the environment here. The second is the DI-friendly form
    // — `fn(env: NodeJS.ProcessEnv = process.env)` — and it was invisible to
    // this gate: IMAGE_MODERATION, MAIL_DEV_MODE and MOCK_IMAGE_PROVIDER are
    // read that way, so losing an anchor line for any of them stayed green.
    // IMAGE_MODERATION defaults to OFF (lib/safety.ts), which makes that one the
    // difference between "images are reviewed" and "nothing is".
    // Only files that declare the parameter are scanned for the property form,
    // so an unrelated `x.env.FOO` elsewhere cannot be mistaken for a variable
    // this gate must demand of the containers.
    const patterns = [/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g];
    if (/\benv\s*:\s*NodeJS\.ProcessEnv\b/.test(src)) {
      patterns.push(/\benv\.([A-Z][A-Z0-9_]*)/g);
    }
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        const list = out.get(m[1]) ?? [];
        if (!list.includes(f)) list.push(f);
        out.set(m[1], list);
      }
    }
  }
  return out;
}

/**
 * Names a container really receives, per compose file, straight from
 * `docker compose config`. Required (`:?`) variables are filled in by feeding
 * compose back the names its own error messages demand.
 *
 * `unrendered` collects the files that could NOT be rendered for a reason other
 * than a missing required variable (which the fixture loop exists to satisfy).
 * A file that fails to render used to be reported on stderr and dropped from
 * `out`, which meant checks 1 and 2b silently did not apply to it — a broken
 * anchor, a tab or a `depends_on` naming an undefined service in
 * docker-compose.single.yml exited 0 with "2 compose file(s) rendered", and the
 * production single-VPS stack then failed on the operator's host instead of in
 * CI. The `.env.example` half of this script still cannot see such a file, so
 * the only honest answer is to fail.
 */
function composeForwarded(): { forwarded: Map<string, Set<string>>; unrendered: string[] } {
  const out = new Map<string, Set<string>>();
  const unrendered: string[] = [];
  const fixture = new Map<string, string>([
    // Values only need to be non-empty; nothing here is dialled.
    ["NEXTAUTH_SECRET", "0".repeat(48)],
    ["NEXTAUTH_URL", "https://config-check.invalid"],
  ]);
  for (const file of COMPOSE_FILES) {
    let json: string | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      const envFile = path.join(
        fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "pd-config-")),
        ".env",
      );
      fs.writeFileSync(envFile, [...fixture].map(([k, v]) => `${k}="${v}"`).join("\n"));
      try {
        json = execFileSync(
          "docker",
          ["compose", "--env-file", envFile, "-f", file, "config", "--format", "json"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        break;
      } catch (e) {
        const stderr = String((e as { stderr?: Buffer }).stderr ?? "");
        lastError = stderr.trim();
        const missing = [...stderr.matchAll(/required variable ([A-Z][A-Z0-9_]*) is missing/g)];
        if (!missing.length) {
          console.error(`  [skip] ${file}: docker compose config failed:\n${lastError}`);
          break;
        }
        for (const m of missing) if (!fixture.has(m[1])) fixture.set(m[1], "config-check");
        fixture.set("POSTGRES_PASSWORD", "config-check");
      }
    }
    if (!json) {
      // Either the render failed for a reason the fixture cannot fix, or 40
      // rounds of required-variable discovery were not enough. Both mean the
      // compose checks below never saw this file.
      unrendered.push(`${file}${lastError ? `: ${lastError.split("\n")[0]}` : " (fixture loop exhausted)"}`);
      continue;
    }
    const cfg = JSON.parse(json) as {
      services?: Record<string, { environment?: Record<string, unknown>; build?: { args?: unknown } }>;
    };
    const names = new Set<string>();
    for (const svc of Object.values(cfg.services ?? {})) {
      for (const [k, v] of Object.entries(svc.environment ?? {})) {
        // A null value means "pass through from the host", which is how a
        // compose file can forward a name it never spells out.
        if (v === null) continue;
        names.add(k);
      }
      const args = svc.build?.args;
      if (Array.isArray(args)) for (const a of args) names.add(String(a).split("=")[0]);
      else if (args && typeof args === "object") for (const k of Object.keys(args)) names.add(k);
    }
    out.set(file, names);
  }
  return { forwarded: out, unrendered };
}

function main() {
  const problems: string[] = [];
  const warnings: string[] = [];
  const { keys: documented, duplicates } = readEnvExample();
  if (duplicates.length) problems.push(`${ENV_EXAMPLE} declares ${duplicates.join(", ")} twice`);
  const read = codeReadNames();
  const { forwarded, unrendered } = composeForwarded();
  if (forwarded.size === 0 && unrendered.length === 0) {
    // Skipping is a convenience for a machine with no docker daemon, but in CI
    // it would be a green job that verified nothing — and the compose half is
    // the half that catches the real bugs. There, no docker means failure.
    if (process.env.CI) problems.push("docker is unavailable, so no compose file could be rendered");
    else warnings.push("docker unavailable — compose assertions skipped (.env.example half only)");
  } else if (unrendered.length) {
    // Either some files rendered and these did not, or NOTHING rendered and the
    // cause was not a missing docker daemon (a broken compose plugin, a failing
    // shim). Both mean every compose check below is silently inapplicable to
    // them, so this is never a warning: a file the gate cannot read is exactly
    // what the gate exists to refuse.
    for (const file of unrendered) {
      problems.push(`could not render ${file} — the compose invariants below do not apply to it`);
    }
  }
  const short = (f: string) => f.replace("docker-compose", "dc").replace(".yml", "");

  // 1. Documented + read by the app => must actually reach a container.
  const mustForward = [...documented].filter((k) => read.has(k)).sort();
  for (const name of mustForward) {
    const exempt = NOT_FORWARDED[name];
    const missing = [...forwarded]
      .filter(([, names]) => !names.has(name))
      .map(([f]) => f)
      .filter((f) => !exempt?.files.includes(f));
    if (missing.length) {
      problems.push(
        `${name} is documented and read by ${read.get(name)!.join(", ")} but no anchor forwards it to ${missing.map(short).join(", ")}${exempt ? ` (exempt elsewhere: ${exempt.reason})` : ""}`,
      );
    }
  }

  // 2. Forwarded => must be documented (or be a known neighbour-wiring name).
  for (const [file, names] of forwarded) {
    for (const name of names) {
      if (documented.has(name) || name.startsWith("NEXT_PUBLIC_")) continue;
      if (INTERNAL_FORWARDED[name]) continue;
      problems.push(`${short(file)} forwards ${name}, which ${ENV_EXAMPLE} does not document`);
    }
  }

  // 2b. An exemption for a variable the file DOES forward is not an exemption,
  //     it is a hole: it silently un-protects that anchor, so the day someone
  //     deletes the line the gate stays green. Four of these had accumulated
  //     (the prod/single escape hatches all carry their anchors). Fail instead —
  //     the fix is one deleted entry, and the reason string belongs to the case
  //     where the name really is missing.
  for (const [name, exempt] of Object.entries(NOT_FORWARDED)) {
    const redundant = exempt.files.filter((f) => forwarded.get(f)?.has(name));
    if (redundant.length) {
      problems.push(
        `stale exemption: ${name} is already forwarded by ${redundant.map(short).join(", ")} — delete its NOT_FORWARDED entry so the anchor is protected`,
      );
    }
  }

  // 3. Read by the app but documented nowhere: a warning, not a failure —
  //    plenty of these are Node/Next runtime vars.
  for (const name of [...read.keys()].sort()) {
    if (documented.has(name) || INTERNAL_FORWARDED[name]) continue;
    if (/^(NODE_ENV|NEXT_RUNTIME|NEXT_TELEMETRY_DISABLED|HOSTNAME|PORT|VERCEL|CI|VITEST|PW_|npm_)/.test(name)) continue;
    warnings.push(`${name} is read (${read.get(name)!.join(", ")}) but not in ${ENV_EXAMPLE}`);
  }

  for (const w of warnings) console.log(`warn: ${w}`);
  for (const p of problems) console.error(`FAIL: ${p}`);
  if (problems.length) {
    console.error(`\n${problems.length} configuration problem(s).`);
    process.exit(1);
  }
  console.log(
    `config OK — ${documented.size} documented, ${mustForward.length} reaching a container, ${forwarded.size} compose file(s) rendered`,
  );
}

main();
