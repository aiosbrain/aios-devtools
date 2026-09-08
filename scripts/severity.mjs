/**
 * severity.mjs — the canonical finding-severity vocabulary, ranking helpers, AND the
 * structural severity matchers, as a dependency-free core leaf module.
 *
 * SEVERITY_RANK and the ranking helpers moved here (AIO-594) from
 * scripts/review-bugbot/findings.mjs and scripts/consolidate-findings.mjs respectively;
 * the structural matchers (`hasFindingsAtOrAbove`, `hasCriticalOrHighFindings`,
 * `canonicalSeverity`) followed in the devtools-seam wave (AIO-594 F1): the devtools-bound
 * consolidator and build loop gate on them, and core-staying commands must not import from
 * the devtools path set — nor devtools files statically from review-bugbot. findings.mjs
 * (the verdict-protocol dialect) and consolidate-findings.mjs both re-export these for
 * back-compat, so no existing call site changes meaning. This leaf is the ONE home of the
 * matcher — do not duplicate it elsewhere (it is the mutation target for the
 * severity-classification concern).
 */

// Rank for merging/comparing severities across sources (used by the consolidator).
export const SEVERITY_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 };

export function rankSeverity(sev) {
  return SEVERITY_RANK[sev] ?? 0;
}

export function normalizeSeverity(s) {
  const t = String(s ?? "").toLowerCase();
  if (t.startsWith("crit")) return "Critical";
  if (t === "high") return "High";
  if (t === "medium" || t === "med") return "Medium";
  if (t === "low") return "Low";
  return null;
}

// Stable, deterministic severity order shared by report-only review fan-outs.
// Equal-severity findings retain their source order.
export function rankFindings(findings) {
  return findings
    .map((finding, sourceIndex) => ({
      ...finding,
      severity: normalizeSeverity(finding?.severity) ?? "Low",
      sourceIndex,
    }))
    .sort(
      (a, b) => rankSeverity(b.severity) - rankSeverity(a.severity) || a.sourceIndex - b.sourceIndex
    )
    .map(({ sourceIndex: _sourceIndex, ...finding }) => finding);
}

/** The canonical-cased severity name for a case-insensitive value, or null. */
export function canonicalSeverity(value) {
  const found = Object.keys(SEVERITY_RANK).find(
    (severity) => severity.toLowerCase() === String(value ?? "").toLowerCase()
  );
  return found ?? null;
}

// Structural matchers for listed findings: a leading bullet (`- Critical: …`), a leading
// severity table cell (`| High |`), the bracket form (`[High] file:line — …`) emitted by
// code-reviewer.md, or GPT's backticked severity/file bullet. Prose such as "no Critical or
// High findings" matches NONE of these — only an actual listed finding. This is the single
// severity dialect for the review loop, consolidator gate, and observation inventory.
// All three tolerate markdown emphasis around the severity (`**[High]**`, `**High**`): the
// consolidator model bolds findings, and a decoration-blind matcher silently downgraded a
// BLOCKED round to CLEAR (AIO-239 / observation.md §9 — the verdict must not hinge on `**`).
// Keep every supported record shape here so boolean gating and observation inventory
// consume the exact same per-line classification.
const FINDING_PATTERNS = [
  /^\s*(?:(?:[-*]|\d+[.)]|#{1,6})\s+)?(?:\*\*|__|\*|_)?`?(Critical|High|Medium|Low)\s+Severity`?(?:\*\*|__|\*|_)?\s*(?::|—|-\s+|$)/i,
  /^\s*(?:[-*]|\d+[.)])\s*`(Critical|High|Medium|Low)`\s+`[^`\n]+`/i,
  /^\s*(?:[-*]|\d+[.)])\s*(?:\*\*|__|\*|_)?`?(Critical|High|Medium|Low)`?(?:\*\*|__|\*|_)?\s*(?::|—|-\s+)/i,
  /^\s*(?:[-*]|\d+[.)])\s*(?:\*\*|__|\*|_)?\[(Critical|High|Medium|Low)\](?:\*\*|__|\*|_)?/i,
  /^\s*\|\s*(?:\*\*|__|\*|_)?`?(Critical|High|Medium|Low)`?(?:\*\*|__|\*|_)?\s*\|/i,
  /^\s*(?:\*\*|__|\*|_)?\[(Critical|High|Medium|Low)\](?:\*\*|__|\*|_)?/i,
  /^\s*(?:\*\*|__|\*|_)?`?(Critical|High|Medium|Low)`?(?:\*\*|__|\*|_)?\s*(?::|—|-\s+)/i,
];

/** Canonical severity records, at most one classification for each source line. */
export function extractFindingSeverityRecords(text) {
  const records = [];
  for (const [lineIndex, line] of String(text ?? "").split("\n").entries()) {
    for (const pattern of FINDING_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      records.push({ line: lineIndex + 1, severity: canonicalSeverity(match[1]) });
      break;
    }
  }
  return records;
}

/** True when review text contains a listed finding at or above the requested severity. */
export function hasFindingsAtOrAbove(text, failOn = "high") {
  const canonical = canonicalSeverity(failOn);
  if (!canonical) throw new Error(`invalid Bugbot severity: ${failOn}`);
  const threshold = SEVERITY_RANK[canonical];
  return extractFindingSeverityRecords(text).some(
    ({ severity }) => SEVERITY_RANK[severity] >= threshold
  );
}

/** True when review text lists a Critical/High finding (bullet, table row, or bracket). */
export function hasCriticalOrHighFindings(text) {
  return hasFindingsAtOrAbove(text, "high");
}
