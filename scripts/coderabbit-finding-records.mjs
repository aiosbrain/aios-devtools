// CodeRabbit dialect adapter. It returns only structural positions and severity enums.
import { extractFindingSeverityRecords } from "./finding-severity-records.mjs";

function severityForToken(token, fallback = null) {
  const normalized = token?.toLowerCase();
  if (["critical", "blocker"].includes(normalized)) return "critical";
  if (["major", "high"].includes(normalized)) return "high";
  if (["medium", "minor"].includes(normalized)) return "medium";
  if (["low", "nitpick"].includes(normalized)) return "low";
  return fallback;
}

function structuredRecords(text) {
  const records = [];
  const pattern = /\*\*([A-Z]+)(?: severity)?(?::\*\*|\*\*\s*:)/gi;
  for (const match of text.matchAll(pattern)) {
    const severity = severityForToken(match[1]);
    if (severity) records.push({ severity, line: text.slice(0, match.index).split("\n").length });
  }
  return records;
}

function legacySeverity(lineText) {
  if (/^\s*_[^A-Z0-9]*nitpick_\s*$/i.test(lineText)) return "low";
  let label = lineText.trim().replace(/^(?:[-*]\s+)/, "").replace(/^(?:\*\*|__)/, "");
  const token = /^(major|minor|nitpick)/i.exec(label)?.[1];
  if (!token) return null;
  label = label.slice(token.length).replace(/^(?:\*\*|__)/, "");
  if (!/^(?:\s*[:—-]\s*|\s+)\S/.test(label)) return null;
  return severityForToken(token);
}

function addCanonicalRecords(found, text) {
  for (const { line, severity } of extractFindingSeverityRecords(text)) {
    if (!found.some((record) => record.line === line)) {
      found.push({ line, severity: severity.toLowerCase() });
    }
  }
}

function addLegacyRecords(found, lines) {
  for (const [index, lineText] of lines.entries()) {
    const line = index + 1;
    if (found.some((record) => record.line === line)) continue;
    const severity = legacySeverity(lineText);
    if (severity) found.push({ line, severity });
  }
}

function addPotentialRecords(found, lines) {
  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    if (!/potential issue/i.test(text) || found.some((record) => record.line === line)) continue;
    const token = /(critical|blocker|major|minor|nitpick)/i.exec(text)?.[1];
    const severity = severityForToken(token, "high");
    const nextContent = lines.findIndex((candidate, candidateIndex) => candidateIndex + 1 > line && candidate.trim()) + 1;
    const followedByLabel = found.some((record) => record.line === nextContent && (!token || record.severity === severity));
    if (!followedByLabel) found.push({ line, severity });
  }
}

export function extractCodeRabbitFindingRecords(body, item, itemIdentity, digest) {
  const text = String(body ?? "");
  const lines = text.split("\n");
  const found = structuredRecords(text);
  addCanonicalRecords(found, text);
  addLegacyRecords(found, lines);
  addPotentialRecords(found, lines);
  found.sort((left, right) => left.line - right.line);
  if (found.length) {
    return found.map(({ line, severity }) => ({
      severity,
      evidence_sha256: digest({ item: itemIdentity, line, severity }),
      source_locator: { kind: "item-line", item, line },
    }));
  }
  if (!/severity/i.test(text)) return [];
  return [{
    severity: "unknown",
    evidence_sha256: digest({ item: itemIdentity, line: 1, severity: "unknown" }),
    source_locator: { kind: "item-line", item, line: 1 },
  }];
}
