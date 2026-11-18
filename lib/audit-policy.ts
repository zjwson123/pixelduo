// The runtime audit gate's exception list (pass 63).
//
// `npm audit --omit=dev --audit-level=high` is the deploy gate, and it reads
// the LOCKFILE's production scope. An advisory with NO published patch cannot
// be cleared by bumping or overriding: GHSA-fc5q-39xc-vjpf (picomatch <=4.0.7,
// high, ReDoS through a crafted extglob) is the first such case in this tree —
// the advisory's own "patched versions" is empty and the registry's latest
// release is still 4.0.7.
//
// The exception is deliberately narrow and expiring:
//
//  - keyed by GHSA id AND package, so another advisory on picomatch (or the
//    same advisory on another package) is not covered;
//  - only high/critical findings are considered at all, and an ancestor finding
//    is explained only if every advisory object in its `via` is the allowed
//    one and every parent chain ends at the allowed package — npm reports the
//    whole path, and a new advisory anywhere on it must fail the gate;
//  - the script refuses the exception as soon as `npm view` answers with a
//    version above the advisory's upper bound, so a published patch forces a
//    real bump instead of silent acceptance;
//  - the compensating control is the artifact: picomatch here rides on
//    @sentry/nextjs's BUILD-time rollup plugin, never on a served request, and
//    both shipped images assert /app/node_modules/picomatch and @rollup are
//    absent (Dockerfile runtime-deps + the web/worker gates).
export interface AuditException {
  /** The single GHSA this exception covers. */
  id: string;
  /** The only package it may cover. */
  package: string;
  /** The advisory's highest affected version; a newer release expires this. */
  maxAffectedVersion: string;
  reason: string;
}

export const AUDIT_EXCEPTIONS: AuditException[] = [
  {
    id: "GHSA-fc5q-39xc-vjpf",
    package: "picomatch",
    maxAffectedVersion: "4.0.7",
    reason:
      "no patched release published; reached only by @sentry/nextjs's build-time rollup plugin, and both shipped images assert the package is absent",
  },
];

export interface AuditAdvisoryVia {
  url?: string;
  name?: string;
  title?: string;
  severity?: string;
  range?: string;
}

export interface AuditVulnerability {
  name: string;
  severity: string;
  via: Array<string | AuditAdvisoryVia>;
}

export interface AuditReport {
  auditReportVersion?: number;
  vulnerabilities?: Record<string, AuditVulnerability>;
}

/**
 * Whether `report` is a real `npm audit --json` result. The script is invoked
 * from gates that just saw a high finding, so an error envelope
 * (`{"error":{"code":"EALLOWSCRIPTS",…}}` — which npm emits when it inherits
 * `npm_config_allow_scripts` from an `npx` parent) or an empty report must not
 * read as "no vulnerabilities"; `unexplainedFindings({})` is legitimately
 * empty, which made the first version of this gate pass on that envelope.
 */
export function auditReportIsUsable(report: unknown): report is AuditReport {
  if (!report || typeof report !== "object") return false;
  const r = report as AuditReport;
  return (
    r.auditReportVersion === 2 &&
    typeof r.vulnerabilities === "object" &&
    r.vulnerabilities !== null &&
    !Array.isArray(r.vulnerabilities)
  );
}

function advisoryId(via: AuditAdvisoryVia): string | null {
  return /GHSA-[a-z0-9-]+/i.exec(via.url ?? "")?.[0]?.toLowerCase() ?? null;
}

/**
 * The high/critical findings the exception list does NOT explain. Empty means
 * the report's blocking findings are exactly the documented exceptions (or
 * there are none).
 */
export function unexplainedFindings(
  report: AuditReport,
  exceptions: AuditException[] = AUDIT_EXCEPTIONS,
): string[] {
  const vulns = report.vulnerabilities ?? {};
  const allowed = new Map(exceptions.map((e) => [e.package, e.id.toLowerCase()]));
  const memo = new Map<string, boolean>();

  function explained(name: string, stack: Set<string>): boolean {
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    if (stack.has(name)) return false;
    stack.add(name);
    const v = vulns[name];
    let ok = false;
    if (v) {
      const objects = v.via.filter(
        (x): x is AuditAdvisoryVia => typeof x === "object" && x !== null,
      );
      const parents = v.via.filter((x): x is string => typeof x === "string");
      if (objects.length > 0) {
        // The finding itself carries an advisory: only the exception's own
        // package, and only when EVERY advisory on it is the allowed one.
        const id = allowed.get(name);
        ok = Boolean(id) && objects.every((o) => advisoryId(o) === id);
      } else {
        // An ancestor npm flags because a descendant is vulnerable: it is
        // explained only when every path ends at an explained package.
        ok = parents.length > 0 && parents.every((p) => explained(p, stack));
      }
    }
    stack.delete(name);
    memo.set(name, ok);
    return ok;
  }

  const out: string[] = [];
  for (const [name, v] of Object.entries(vulns)) {
    if (v.severity !== "high" && v.severity !== "critical") continue;
    if (!explained(name, new Set())) out.push(`${name} (${v.severity})`);
  }
  return out;
}
