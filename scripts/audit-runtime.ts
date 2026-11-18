/**
 * The runtime advisory gate, with the one documented exception (pass 63).
 *
 * Both CI and scripts/ci-local.sh run `npm audit --omit=dev --audit-level=high`
 * first. When it fails for a real finding, this script re-reads the machine
 * report and decides whether EVERY blocking finding is explained by
 * lib/audit-policy.ts's exception list — a GHSA with no published patch whose
 * package is absent from both shipped images (asserted by the build gates).
 * Anything else fails, exactly as before.
 *
 * It also refuses an exception once the registry publishes a version above the
 * advisory's affected range: at that point the fix is a bump, not an exception.
 *
 * It is NOT a standalone clean-tree gate: a valid report with no high finding
 * fails, because the caller only reaches this script after one saw a high.
 */

import { spawnSync } from "node:child_process";
import {
  AUDIT_EXCEPTIONS,
  auditReportIsUsable,
  unexplainedFindings,
  type AuditException,
  type AuditReport,
} from "../lib/audit-policy";

// `npx` (how both gates invoke this script) exports npm_config_allow_scripts,
// and a CHILD `npm audit` then refuses with EALLOWSCRIPTS instead of running
// the audit. The envelope parses as JSON, so the first version of this script
// read it as "no vulnerabilities" and cleared the gate — a fail-open. Strip the
// npm-injected switches that change this command's behaviour; files (.npmrc)
// and the caller's own environment still apply.
const INHERITED_NPM_SWITCHES = new Set([
  "npm_config_allow_scripts",
  "npm_config_audit",
  "npm_config_audit_level",
  "npm_config_json",
  "npm_config_omit",
  "npm_config_production",
  "npm_config_only",
  "npm_config_include",
]);
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (INHERITED_NPM_SWITCHES.has(key.toLowerCase())) delete env[key];
  }
  return env;
}

function npm(args: string[]) {
  return spawnSync("npm", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    env: cleanEnv(),
  });
}

function readReport(): { report: AuditReport | null; raw: string; endpointError: boolean } {
  const r = npm(["audit", "--omit=dev", "--json"]);
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  try {
    const parsed: unknown = JSON.parse(r.stdout || "{}");
    if (auditReportIsUsable(parsed)) return { report: parsed, raw, endpointError: false };
    // An error envelope or any other shape is not evidence of a clean tree.
    return { report: null, raw, endpointError: false };
  } catch {
    return {
      report: null,
      raw,
      endpointError: /audit endpoint returned an error/i.test(raw),
    };
  }
}

function printHumanReport(): void {
  const r = npm(["audit", "--omit=dev", "--audit-level=high"]);
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
}

/**
 * Whether a release above the advisory's affected range exists.
 * true = a patch exists (refuse the exception), false = still vulnerable
 * upstream, null = the registry could not answer (fail closed).
 */
function patchedReleaseExists(exception: AuditException): boolean | null {
  const r = spawnSync("npm", ["view", `${exception.package}@>${exception.maxAffectedVersion}`, "version"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (r.status === 0) return Boolean((r.stdout ?? "").trim());
  if (/No match found for version/i.test(`${r.stderr ?? ""}`)) return false;
  return null;
}

let last = readReport();
for (let attempt = 1; !last.report && last.endpointError && attempt < 3; attempt++) {
  console.error(`[audit] registry audit endpoint unavailable (attempt ${attempt}/3) — retrying`);
  spawnSync("sleep", ["5"]);
  last = readReport();
}
if (!last.report) {
  console.error(last.raw);
  console.error(
    "[audit] the registry audit endpoint stayed unavailable — refusing to report a runtime tree it never checked",
  );
  process.exit(1);
}

const blocking = Object.values(last.report.vulnerabilities ?? {}).filter(
  (v) => v.severity === "high" || v.severity === "critical",
);
if (blocking.length === 0) {
  // This script is invoked only after the plain gate saw a high finding. A
  // valid report with none is a contradiction (the advisory database or the
  // invocation changed between the two calls), not a clean bill of health.
  console.error(
    "[audit] the gate reported a high finding but the JSON report has none — refusing to clear it",
  );
  process.exit(1);
}

const unexplained = unexplainedFindings(last.report);
if (unexplained.length > 0) {
  printHumanReport();
  console.error(
    `[audit] ${unexplained.length} unexplained high/critical finding(s): ${unexplained.join(", ")}`,
  );
  process.exit(1);
}

// Every blocking finding is explained by the exception list. An exception is
// only valid while no patched release exists; otherwise the gate would keep
// accepting an advisory whose fix is one version bump away.
for (const exception of AUDIT_EXCEPTIONS) {
  const patched = patchedReleaseExists(exception);
  if (patched === null) {
    console.error(
      `[audit] could not check whether a patched ${exception.package} release exists — refusing the ${exception.id} exception (fail closed)`,
    );
    process.exit(1);
  }
  if (patched) {
    printHumanReport();
    console.error(
      `[audit] a ${exception.package} release above ${exception.maxAffectedVersion} now exists — bump it and drop the ${exception.id} exception`,
    );
    process.exit(1);
  }
  console.error(`[audit] allowing ${exception.id} in ${exception.package}: ${exception.reason}`);
}
process.exit(0);
