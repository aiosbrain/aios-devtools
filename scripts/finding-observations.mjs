// Opt-in finding-observation producer for consolidate-findings (AIO-1100).
// This leaf owns sanitization, identity, validation, and the fail-closed local writer.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { extractFindingSeverityRecords } from "./finding-severity-records.mjs";
import { checkIsPending, checkIsRed } from "./ci-status.mjs";
import { writeAtomicJsonl } from "./atomic-jsonl.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.join(HERE, "..", "contracts");
export const SCHEMA_PATH = path.join(CONTRACTS, "finding-observations.v1.schema.json");
export const REGISTRY_PATH = path.join(CONTRACTS, "finding-observations.registry.v1.json");
export const PIN_PATH = path.join(CONTRACTS, "finding-observations.v1.sha256");
export const SCHEMA_SHA256 = "a51f360769ab26440287891867447baf6e3df93073df6f0d7febc1f3c10322b2";
export const PRODUCER_NAME = "aios-devtools";
export const PRODUCER_VERSION = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version;
const DOMAIN_CANDIDATE = "aios.finding.candidate.discovery.v1\0";
const DOMAIN_EVENT = "aios.finding.event.v1\0";
const TAXONOMY = {
  severity: new Set(["critical", "high", "medium", "low", "unknown"]),
  defect_class: new Set([
    "logic", "security", "gate-integrity", "test-integrity", "verifiability",
    "contract-drift", "docs", "perf", "unknown",
  ]),
  determinism: new Set(["deterministic", "flaky", "unverified", "unknown"]),
  fences: new Set(["none", "migration", "credential", "schema", "public-api", "release", "unknown"]),
};
const OUTCOMES = new Set(["verified", "duplicate", "rejected", "incomplete"]);
const TRANSITIONS = new Map([
  ["discovered", new Set(["verified", "duplicate", "rejected", "incomplete"])],
  ["verified", new Set(["filed", "duplicate", "rejected", "incomplete"])],
  ["filed", new Set(["queue_eligible", "duplicate", "rejected", "incomplete"])],
  ["queue_eligible", new Set(["selected", "duplicate", "rejected", "incomplete"])],
  ["selected", new Set(["remediation_started", "duplicate", "rejected", "incomplete"])],
  ["remediation_started", new Set(["merged", "duplicate", "rejected", "incomplete"])],
  ["merged", new Set(["resolved", "incomplete"])],
  ["resolved", new Set(["escaped", "reopened"])],
  ["escaped", new Set(["reopened", "incomplete"])],
  ["duplicate", new Set(["reopened"])], ["rejected", new Set(["reopened"])],
  ["incomplete", new Set(["reopened"])],
  ["reopened", new Set(["verified", "duplicate", "rejected", "incomplete"])],
]);
const TERMINAL = new Map([
  ["discovery", new Set(["verified", "filed", "queue_eligible", "selected", "remediation_started", "merged", "resolved", "duplicate", "rejected"])],
  ["filing", new Set(["filed", "queue_eligible", "selected", "remediation_started", "merged", "resolved", "duplicate", "rejected"])],
  ["remediation", new Set(["merged", "resolved", "duplicate", "rejected"])],
  ["resolution", new Set(["resolved", "duplicate", "rejected"])],
]);
const DECISION_KEYS = new Set([
  "source_key", "outcome", "duplicate_target", "codebases", "taxonomy", "evidence_status",
]);
const TAXONOMY_KEYS = new Set(["severity", "defect_class", "determinism", "fences"]);
const LINKS = Object.freeze({ linear: null, scanner: null, pull_request: null, merge: null, resolution: null });

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function domainHash(domain, value) {
  return sha256(Buffer.concat([Buffer.from(domain, "ascii"), Buffer.from(canonical(value), "utf8")]));
}

function eventWithId(record) {
  return { ...record, event_id: findingEventId(record) };
}

export const findingEventId = (recordWithoutId) => domainHash(DOMAIN_EVENT, recordWithoutId);

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) throw new Error(`${label} contains unsafe field: ${extras[0]}`);
}

function parseIssue(issue) {
  const m = String(issue).match(/^([A-Z][A-Z0-9]{1,9})-(\d+)$/);
  return m ? { type: "linear", team: m[1], number: Number(m[2]) } : null;
}

function resolvePartition(registry, issue, repoSlug) {
  const codebase = registry.codebase_mappings[repoSlug];
  if (!codebase) throw new Error(`unregistered repository mapping: ${repoSlug}`);
  const issueRef = parseIssue(issue);
  if (!issueRef || !registry.linear_teams.includes(issueRef.team)) throw new Error(`unregistered issue team: ${issue}`);
  return { codebase, issueRef };
}

function textFindingRecords(text, dialect = "canonical") {
  const source = String(text ?? "");
  const lines = source.split("\n");
  const starts = []; let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const found = extractFindingSeverityRecords(text, { dialect });
  return found.map(({ line, severity }, index) => ({
    severity: severity.toLowerCase(),
    evidence_sha256: sha256(lines.slice(line - 1, (found[index + 1]?.line ?? lines.length + 1) - 1).join("\n")),
    evidence_end_offset: found[index + 1] ? starts[found[index + 1].line - 1] : source.length,
    source_locator: { kind: "line", line },
  }));
}

function codeRabbitItemIdentity(value) {
  const identity = {};
  if (value.path !== undefined) {
    if (typeof value.path !== "string" || value.path.length > 500 || value.path.startsWith("/") || /(^|\/)\.\.(\/|$)|[\u0000-\u001f]/.test(value.path)) throw new Error("unsafe CodeRabbit path");
    identity.path = value.path;
  }
  if (value.line !== undefined && value.line !== null) {
    if (!Number.isInteger(value.line) || value.line < 1) throw new Error("unsafe CodeRabbit line");
    identity.line = value.line;
  }
  for (const key of ["created_at", "submitted_at", "state"]) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || value[key].length > 64 || /[\u0000-\u001f]/.test(value[key])) throw new Error(`unsafe CodeRabbit ${key}`);
      identity[key] = value[key];
    }
  }
  return sha256(canonical(identity));
}

function codeRabbitRecords(body, item, itemIdentity) {
  const text = String(body ?? "");
  const lines = text.split("\n");
  const structured = [...text.matchAll(/\*\*(critical|blocker|major|high|medium|minor|low|nitpick)(?:\s+severity)?(?::\*\*|\*\*\s*:)/gi)];
  const found = structured.map((m) => {
    const token = m[1].toLowerCase();
    const severity = ["critical", "blocker"].includes(token) ? "critical"
      : ["major", "high"].includes(token) ? "high"
        : ["medium", "minor"].includes(token) ? "medium" : "low";
    const line = text.slice(0, m.index).split("\n").length;
    return { severity, line };
  });
  for (const { line, severity } of extractFindingSeverityRecords(text)) {
    if (!found.some((record) => record.line === line)) found.push({ line, severity: severity.toLowerCase() });
  }
  for (const [index, lineText] of lines.entries()) {
    if (found.some((record) => record.line === index + 1)) continue;
    const label = lineText.match(/^\s*(?:[-*]\s*)?(?:\*\*|__)?(major|minor|nitpick)(?:\*\*|__)?(?:\s*(?::|—|-)\s*|\s+).+/i)?.[1]?.toLowerCase();
    const severity = label === "major" ? "high" : label === "minor" ? "medium" : label === "nitpick" ? "low"
      : /^\s*_[^A-Za-z0-9]*nitpick_\s*$/i.test(lineText) ? "low" : null;
    if (severity) found.push({ line: index + 1, severity });
  }
  const potentialLines = lines.flatMap((line, index) => /potential issue/i.test(line) ? [{ line: index + 1, text: line }] : []);
  for (const [index, potential] of potentialLines.entries()) {
    if (found.some((record) => record.line === potential.line)) continue;
    const token = potential.text.match(/(critical|blocker|major|minor|nitpick)/i)?.[1]?.toLowerCase();
    const next = potentialLines[index + 1]?.line ?? lines.length + 1;
    const hasFollowingLabel = found.some((record) => record.line > potential.line && record.line < next);
    if (hasFollowingLabel) continue;
    found.push({ line: potential.line, severity: ["critical", "blocker"].includes(token) ? "critical" : token === "minor" ? "medium" : token === "nitpick" ? "low" : "high" });
  }
  found.sort((a, b) => a.line - b.line);
  if (found.length) return found.map(({ line, severity }, index) => ({
    severity,
    evidence_sha256: sha256(canonical({ item: itemIdentity, evidence: lines.slice(line - 1, (found[index + 1]?.line ?? lines.length + 1) - 1).join("\n") })),
    source_locator: { kind: "item-line", item, line },
  }));
  return /severity/i.test(text)
    ? [{ severity: "unknown", evidence_sha256: sha256(canonical({ item: itemIdentity, evidence: text })), source_locator: { kind: "item-line", item, line: 1 } }]
    : [];
}

function makeInventoryRecords(inputs) {
  const sources = [];
  let malformed = 0;
  if (!inputs.checks?.checks?.length && (inputs.checks?.ciRed || inputs.checks?.ciPending)) {
    throw new Error("plaintext CI evidence has no trustworthy candidate denominator");
  }
  sources.push({ source_type: "local-bugbot", records: textFindingRecords(inputs.localBugbotMarkdown) });
  const visibleChars = inputs.gptObservationVisibleChars ?? Number.POSITIVE_INFINITY;
  sources.push({ source_type: "gpt", records: textFindingRecords(inputs.gptObservationMarkdown ?? inputs.gptMarkdown, "gpt").map((record) => ({ ...record, evidence_available: record.evidence_end_offset <= visibleChars })) });
  for (const [source_type, items] of [
    ["coderabbit-issue", inputs.issueComments], ["coderabbit-inline", inputs.inlineComments],
    ["coderabbit-review", inputs.reviews],
  ]) {
    const records = [];
    for (const [itemIndex, item] of (items ?? []).entries()) {
      if (!item || typeof item !== "object" || (item.body !== undefined && typeof item.body !== "string")) { malformed++; continue; }
      try { records.push(...codeRabbitRecords(item.body, itemIndex, codeRabbitItemIdentity(item))); }
      catch { malformed++; }
    }
    sources.push({ source_type, records });
  }
  const ci = [];
  for (const [item, check] of (inputs.checks?.checks ?? []).entries()) {
    if (checkIsRed(check)) {
      ci.push({ severity: "high", evidence_sha256: sha256(canonical(check)), source_locator: { kind: "check", item } });
    } else if (checkIsPending(check)) {
      ci.push({ severity: "unknown", evidence_sha256: sha256(canonical(check)), source_locator: { kind: "check", item } });
    }
  }
  sources.push({ source_type: "ci", records: ci });
  const candidates = sources.flatMap(({ source_type, records }) => {
    const ordered = [...records].sort((a, b) => a.evidence_sha256.localeCompare(b.evidence_sha256) || a.severity.localeCompare(b.severity));
    const source_artifact_sha256 = sha256(canonical({ source_type, records: ordered.map(({ severity, evidence_sha256 }) => ({ severity, evidence_sha256 })) }));
    return ordered.map(({ severity, evidence_sha256, source_locator, evidence_available = true }, source_position) => {
      const source_key = sha256(canonical({ source_type, source_artifact_sha256, source_local_position: source_position }));
      return { source_type, source_position, severity, evidence_sha256, source_artifact_sha256, source_key, source_locator, evidence_available };
    });
  }).sort((a, b) => a.source_key.localeCompare(b.source_key));
  return { candidates, malformed };
}

export function loadFindingRegistry(configPath = null) {
  const registry = JSON.parse(readFileSync(configPath ? path.resolve(configPath) : REGISTRY_PATH, "utf8"));
  exactKeys(registry, new Set(["schema_version", "producer", "codebase_mappings", "linear_teams"]), "registry");
  if (registry.schema_version !== "finding-observations.registry.v1") throw new Error("unsupported finding registry version");
  exactKeys(registry.producer, new Set(["name", "versions"]), "registry producer");
  if (registry.producer.name !== PRODUCER_NAME || !registry.producer.versions?.includes(PRODUCER_VERSION)) {
    throw new Error(`producer ${PRODUCER_NAME}@${PRODUCER_VERSION} is not trusted`);
  }
  if (!registry.codebase_mappings || Object.getPrototypeOf(registry.codebase_mappings) !== Object.prototype) {
    throw new Error("registry codebase_mappings must be an object");
  }
  for (const value of Object.values(registry.codebase_mappings)) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw new Error(`unsafe registered codebase: ${value}`);
  }
  if (!Array.isArray(registry.linear_teams) || registry.linear_teams.some((v) => !/^[A-Z][A-Z0-9]{1,9}$/.test(v))) {
    throw new Error("registry linear_teams is invalid");
  }
  return registry;
}

export function normalizeFindingInventory(inputs, { repoSlug, issue, pr, round = 1, registry, observedAt }) {
  const { codebase, issueRef } = resolvePartition(registry, issue, repoSlug);
  const { candidates, malformed } = makeInventoryRecords(inputs);
  const sanitized = candidates.map(({ source_type, source_position, severity, source_artifact_sha256, source_key }) => ({
    source_type, source_position, severity, source_artifact_sha256, source_key,
  }));
  const detector = { capture_status: "complete", detector_completed: true, raw_candidates: candidates.length + malformed, malformed, candidates: sanitized };
  const detector_evidence_sha256 = sha256(canonical(detector));
  const at = observedAt ?? inputs.latestCommit?.committed_at;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(at ?? "")) throw new Error("inventory observation time is unavailable");
  const runSeed = { issue, pr: Number(pr), round, head: inputs.latestCommit?.sha ?? null, detector_evidence_sha256, observed_at: at };
  return {
    capture_status: "complete", detector_completed: true, detector_evidence_sha256,
    raw_candidates: candidates.length + malformed, malformed, candidates, codebase, issue_ref: issueRef, observed_at: at,
    run_id: sha256(canonical(runSeed)), program_id: sha256(canonical({ issue, codebase })),
    attribution_run_id: sha256(canonical({ issue, pr: Number(pr), round, head: inputs.latestCommit?.sha ?? null, observed_at: at })), attempt: round,
    allowed_codebases: [...new Set(Object.values(registry.codebase_mappings))].sort(),
    pr: Number(pr),
  };
}

export function buildFindingEnvelopePrompt(basePrompt, inventory) {
  const opaque = inventory.candidates.map((c) => ({
    source_key: c.source_key,
    source_type: c.source_type,
    source_position: c.source_position,
    source_locator: c.source_locator,
    hinted_severity: c.severity,
    evidence_available: c.evidence_available,
  }));
  return `${basePrompt}\n\n## Machine observation response (required)\n\nReturn ONLY one JSON object with exactly ` +
    '`report_markdown` and `decisions`. `report_markdown` is the report requested above. ' +
    'Provide exactly one decision for every opaque source key and no others. Each decision has exactly ' +
    '`source_key`, `outcome`, `duplicate_target`, `codebases`, `taxonomy`, and `evidence_status`. ' +
    '`outcome` is verified, duplicate, rejected, or incomplete. `duplicate_target` is another listed ' +
    'source key only for duplicate, otherwise null. Taxonomy enums: severity critical/high/medium/low/unknown; ' +
    'defect_class logic/security/gate-integrity/test-integrity/verifiability/contract-drift/docs/perf/unknown; ' +
    'determinism deterministic/flaky/unverified/unknown. `taxonomy.fences` is a sorted, unique, non-empty array ' +
    'of none/migration/credential/schema/public-api/release/unknown; none and unknown cannot be combined with another fence. ' +
    '`evidence_status` is complete, incomplete, or unknown: it must be complete for verified/duplicate/rejected, ' +
    'and incomplete or unknown for incomplete. A source with `evidence_available:false` must use outcome incomplete. ' +
    '`codebases` is a sorted, unique, non-empty array including the source codebase. ' +
    `The required source codebase is ${JSON.stringify(inventory.codebase)}. ` +
    `Allowed codebases: ${JSON.stringify(inventory.allowed_codebases)}. ` +
    `Opaque inventory: ${JSON.stringify(opaque)}\n`;
}

export function parseFindingEnvelope(output, inventory, registry) {
  let envelope;
  try { envelope = JSON.parse(String(output)); } catch { throw new Error("model response is not a strict JSON envelope"); }
  exactKeys(envelope, new Set(["report_markdown", "decisions"]), "model envelope");
  if (typeof envelope.report_markdown !== "string" || !Array.isArray(envelope.decisions)) throw new Error("invalid model envelope shape");
  const expected = new Set(inventory.candidates.map((c) => c.source_key));
  const registered = new Set(Object.values(registry.codebase_mappings));
  const byKey = new Map();
  for (const decision of envelope.decisions) {
    exactKeys(decision, DECISION_KEYS, "decision");
    if (!expected.has(decision.source_key)) throw new Error(`invented source key: ${decision.source_key}`);
    if (byKey.has(decision.source_key)) throw new Error(`repeated source key: ${decision.source_key}`);
    if (!OUTCOMES.has(decision.outcome)) throw new Error(`invalid outcome for ${decision.source_key}`);
    if (!inventory.candidates.find((candidate) => candidate.source_key === decision.source_key).evidence_available && decision.outcome !== "incomplete") throw new Error(`decision claims unavailable evidence for ${decision.source_key}`);
    if (!Array.isArray(decision.codebases) || !decision.codebases.length || decision.codebases.some((x) => !registered.has(x))) throw new Error(`unregistered codebase decision for ${decision.source_key}`);
    const sortedCodebases = [...new Set(decision.codebases)].sort();
    if (canonical(sortedCodebases) !== canonical(decision.codebases)) throw new Error(`codebases must be sorted and unique for ${decision.source_key}`);
    if (!sortedCodebases.includes(inventory.codebase)) throw new Error(`decision omits source codebase for ${decision.source_key}`);
    exactKeys(decision.taxonomy, TAXONOMY_KEYS, "taxonomy");
    if (!TAXONOMY.severity.has(decision.taxonomy.severity) || !TAXONOMY.defect_class.has(decision.taxonomy.defect_class) || !TAXONOMY.determinism.has(decision.taxonomy.determinism)) throw new Error(`invalid taxonomy for ${decision.source_key}`);
    const fences = decision.taxonomy.fences;
    if (!Array.isArray(fences) || !fences.length || fences.some((x) => !TAXONOMY.fences.has(x)) || canonical([...new Set(fences)].sort()) !== canonical(fences) || (fences.length > 1 && (fences.includes("none") || fences.includes("unknown")))) throw new Error(`invalid taxonomy fences for ${decision.source_key}`);
    if (!new Set(["complete", "incomplete", "unknown"]).has(decision.evidence_status)) throw new Error(`invalid evidence status for ${decision.source_key}`);
    if (decision.outcome === "incomplete" ? decision.evidence_status === "complete" : decision.evidence_status !== "complete") throw new Error(`outcome/evidence mismatch for ${decision.source_key}`);
    if (decision.outcome === "duplicate") {
      if (!expected.has(decision.duplicate_target) || decision.duplicate_target === decision.source_key) throw new Error(`invalid duplicate target for ${decision.source_key}`);
    } else if (decision.duplicate_target !== null) throw new Error(`unexpected duplicate target for ${decision.source_key}`);
    byKey.set(decision.source_key, { ...decision, codebases: sortedCodebases });
  }
  if (byKey.size !== expected.size) throw new Error("model decisions do not account for every source key");
  for (const start of expected) {
    const seen = new Set([start]); let cursor = start;
    while (byKey.get(cursor)?.outcome === "duplicate") {
      cursor = byKey.get(cursor).duplicate_target;
      if (seen.has(cursor)) throw new Error("duplicate decisions contain a cycle");
      seen.add(cursor);
    }
  }
  return { report_markdown: envelope.report_markdown, decisions: byKey };
}

function common(inventory, evidenceStatus) {
  return {
    schema_version: "finding-observations.v1", visibility_tier: "team",
    producer: { name: PRODUCER_NAME, version: PRODUCER_VERSION, run_id: inventory.run_id },
    observed_at: inventory.observed_at, evidence_status: evidenceStatus,
    attribution: { program_id: inventory.program_id, run_id: inventory.attribution_run_id, attempt: inventory.attempt, issue: inventory.issue_ref },
  };
}

function candidateBase(inventory, source) {
  const identity = {
    version: "discovery.v1", producer_namespace: PRODUCER_NAME, original_run_id: inventory.run_id,
    source_artifact_sha256: source.source_artifact_sha256,
    source_record_key: { kind: "structural_sha256", value: source.source_key },
  };
  return { identity, candidate_id: domainHash(DOMAIN_CANDIDATE, identity) };
}

function eventRecord(inventory, source, base, state, sequence, predecessor, decision = null) {
  const codebases = decision?.codebases ?? [inventory.codebase];
  const taxonomy = decision?.taxonomy ?? { severity: source.severity, defect_class: "unknown", determinism: "unknown", fences: ["unknown"] };
  const evidence = decision?.evidence_status ?? (state === "discovered" ? "complete" : "incomplete");
  const disposition = state === "duplicate" ? "duplicate" : state === "rejected" ? "rejected" : state === "incomplete" ? "unknown" : "open";
  const record = {
    ...common(inventory, evidence), record_type: "candidate", candidate_id: base.candidate_id,
    identity: base.identity, codebases, taxonomy, state, disposition, sequence,
    predecessor_event_id: predecessor, episode: 0,
    duplicate_target: state === "duplicate" ? decision.duplicate_candidate_id : null,
    links: { ...LINKS, pull_request: { type: "pull_request", codebase: inventory.codebase, number: inventory.pr } },
  };
  return eventWithId(record);
}

export function projectFindingObservations(inventory, parsed = null, { partial = false } = {}) {
  const bases = new Map(inventory.candidates.map((source) => [source.source_key, candidateBase(inventory, source)]));
  const records = [];
  let terminal = 0;
  for (const source of inventory.candidates) {
    const base = bases.get(source.source_key);
    const discovered = eventRecord(inventory, source, base, "discovered", 0, null);
    records.push(discovered);
    let decision = parsed?.decisions.get(source.source_key) ?? null;
    if (decision?.outcome === "duplicate") decision = { ...decision, duplicate_candidate_id: bases.get(decision.duplicate_target).candidate_id };
    const state = partial ? "incomplete" : decision.outcome;
    const terminalDecision = partial ? { evidence_status: "incomplete", codebases: [inventory.codebase], taxonomy: discovered.taxonomy } : decision;
    records.push(eventRecord(inventory, source, base, state, 1, discovered.event_id, terminalDecision));
    if (state !== "incomplete") terminal++;
  }
  const captureStatus = partial ? "partial" : inventory.capture_status;
  const evidenceProjection = inventory.candidates.map(({ source_type, source_position, severity, source_artifact_sha256, source_key }) => ({ source_type, source_position, severity, source_artifact_sha256, source_key }));
  const detectorEvidence = partial ? sha256(canonical({ capture_status: "partial", detector_completed: false, raw_candidates: inventory.raw_candidates, malformed: inventory.malformed, candidates: evidenceProjection })) : inventory.detector_evidence_sha256;
  const summary = eventWithId({
    ...common(inventory, partial ? "incomplete" : "complete"), record_type: "run_summary", stage: "discovery",
    capture_status: captureStatus, detector_completed: partial ? false : inventory.detector_completed,
    detector_evidence_sha256: detectorEvidence,
    counts: { raw_candidates: inventory.raw_candidates, emitted_candidates: inventory.candidates.length, terminal_stage: terminal, incomplete: inventory.raw_candidates - terminal, malformed: inventory.malformed },
    emission_gap_reason: inventory.malformed ? "malformed" : "none",
  });
  return [...records, summary];
}

export function projectUnknownSummary({ issue, pr, round = 1, observedAt, registry, repoSlug }) {
  const { codebase, issueRef } = resolvePartition(registry, issue, repoSlug);
  const run_id = sha256(canonical({ issue, pr: Number(pr), round, capture_status: "unknown", observed_at: observedAt }));
  const inventory = { run_id, program_id: sha256(canonical({ issue, codebase })), attribution_run_id: run_id, issue_ref: issueRef, observed_at: observedAt, attempt: round };
  return [eventWithId({
    ...common(inventory, "unknown"), record_type: "run_summary", stage: "discovery", capture_status: "unknown",
    detector_completed: null, detector_evidence_sha256: null,
    counts: { raw_candidates: null, emitted_candidates: null, terminal_stage: null, incomplete: null, malformed: null },
    emission_gap_reason: "unknown",
  })];
}

function validCalendarTimestamp(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) && d.toISOString().replace(/\.000Z$/, "Z") === value;
}

export function validateFindingObservations(records, registry) {
  const schemaBytes = readFileSync(SCHEMA_PATH);
  const pin = readFileSync(PIN_PATH, "utf8").trim().split(/\s+/)[0];
  if (pin !== SCHEMA_SHA256 || sha256(schemaBytes) !== pin) throw new Error("packaged finding schema hash mismatch");
  const ajv = new Ajv2020({ allErrors: true, strict: true, formats: { "date-time": true } });
  const validate = ajv.compile(JSON.parse(schemaBytes));
  const candidates = new Map(); let summary = null; let provenance = null;
  for (const record of records) {
    if (!validate(record)) throw new Error(`finding observation schema error: ${ajv.errorsText(validate.errors)}`);
    if (!validCalendarTimestamp(record.observed_at)) throw new Error("finding observation has invalid calendar timestamp");
    const { event_id, ...withoutId } = record;
    if (event_id !== domainHash(DOMAIN_EVENT, withoutId)) throw new Error("finding observation event_id mismatch");
    if (record.producer.name !== registry.producer.name || !registry.producer.versions.includes(record.producer.version)) throw new Error("finding observation producer is untrusted");
    if (record.attribution.issue && !registry.linear_teams.includes(record.attribution.issue.team)) throw new Error("finding observation team is untrusted");
    const recordProvenance = canonical({ producer: record.producer, attribution: record.attribution });
    if (provenance !== null && provenance !== recordProvenance) throw new Error("finding observation run provenance is inconsistent");
    provenance = recordProvenance;
    if (record.record_type === "run_summary") { if (summary && summary.event_id !== record.event_id) throw new Error("conflicting run summaries"); summary = record; continue; }
    if (canonical([...record.codebases].sort()) !== canonical(record.codebases) || record.codebases.some((x) => !Object.values(registry.codebase_mappings).includes(x))) throw new Error("finding observation codebase is untrusted or unsorted");
    if (record.candidate_id !== domainHash(DOMAIN_CANDIDATE, record.identity)) throw new Error("finding observation candidate_id mismatch");
    if (record.identity.producer_namespace !== record.producer.name || record.identity.original_run_id !== record.producer.run_id) throw new Error("finding discovery provenance is inconsistent");
    const expectedDisposition = record.state === "duplicate" ? "duplicate" : record.state === "rejected" ? "rejected" : record.state === "resolved" ? "resolved" : record.state === "incomplete" ? "unknown" : "open";
    if (record.disposition !== expectedDisposition) throw new Error("finding disposition does not match state");
    if (record.state === "incomplete" ? record.evidence_status === "complete" : record.sequence > 0 && record.evidence_status !== "complete") throw new Error("finding evidence does not match lifecycle state");
    if (record.links.pull_request && (!record.codebases.includes(record.links.pull_request.codebase))) throw new Error("finding pull request is outside codebase membership");
    if (record.duplicate_target !== null && record.state !== "duplicate") throw new Error("duplicate target exists outside duplicate state");
    const fences = record.taxonomy.fences;
    if (canonical([...new Set(fences)].sort()) !== canonical(fences) || (fences.length > 1 && (fences.includes("none") || fences.includes("unknown")))) throw new Error("finding taxonomy fences are invalid");
    const list = candidates.get(record.candidate_id) ?? []; list.push(record); candidates.set(record.candidate_id, list);
  }
  if (!summary) throw new Error("finding observation summary is required");
  for (const list of candidates.values()) {
    list.sort((a, b) => a.sequence - b.sequence);
    if (list[0].sequence !== 0 || list[0].state !== "discovered" || list[0].predecessor_event_id !== null) throw new Error("invalid discovery lifecycle");
    for (let i = 1; i < list.length; i++) {
      if (list[i].sequence !== i || list[i].predecessor_event_id !== list[i - 1].event_id || canonical(list[i].identity) !== canonical(list[0].identity)) throw new Error("invalid finding lifecycle chain");
      if (!TRANSITIONS.get(list[i - 1].state)?.has(list[i].state)) throw new Error(`illegal finding transition: ${list[i - 1].state} -> ${list[i].state}`);
      const expectedEpisode = list[i].state === "reopened" ? list[i - 1].episode + 1 : list[i - 1].episode;
      if (list[i].episode !== expectedEpisode) throw new Error("invalid finding lifecycle episode");
    }
    const duplicate = list.find((x) => x.state === "duplicate");
    if (duplicate && (!candidates.has(duplicate.duplicate_target) || duplicate.duplicate_target === duplicate.candidate_id)) throw new Error("duplicate target is unknown or self-referential");
  }
  for (const start of candidates.keys()) {
    const seen = new Set([start]); let cursor = start;
    for (;;) {
      const edge = candidates.get(cursor)?.find((x) => x.state === "duplicate")?.duplicate_target;
      if (!edge) break;
      if (seen.has(edge)) throw new Error("finding duplicate graph contains a cycle");
      seen.add(edge); cursor = edge;
    }
  }
  if (summary.capture_status !== "unknown") {
    const c = summary.counts;
    const terminal = [...candidates.values()].filter((list) => TERMINAL.get(summary.stage).has(list.at(-1).state)).length;
    if (c.raw_candidates !== c.terminal_stage + c.incomplete || c.raw_candidates - c.emitted_candidates !== c.malformed || c.incomplete !== c.emitted_candidates - c.terminal_stage + c.malformed || c.emitted_candidates !== candidates.size || c.terminal_stage !== terminal || summary.emission_gap_reason !== (c.malformed ? "malformed" : "none")) throw new Error("finding observation summary reconciliation failed");
  } else if (summary.detector_completed !== null || summary.detector_evidence_sha256 !== null || Object.values(summary.counts).some((x) => x !== null) || summary.emission_gap_reason !== "unknown") {
    throw new Error("unknown capture must not claim a denominator");
  }
  return true;
}

export function writeFindingObservations(outputPath, records, registry, { nowMs = Date.now() } = {}) {
  validateFindingObservations(records, registry);
  writeAtomicJsonl(outputPath, `${records.map(canonical).join("\n")}\n`, { nowMs });
}

export function createFindingObservationSession({ outputPath, configPath, issue, pr, round, now, repoSlug }) {
  if (!outputPath) return null;
  const registry = loadFindingRegistry(configPath);
  resolvePartition(registry, issue, repoSlug);
  const observedAt = new Date(now ? now() : Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const safeWrite = (records) => {
    try { writeFindingObservations(outputPath, records, registry); return null; }
    catch (error) { return error; }
  };
  return {
    capture: (inputs) => normalizeFindingInventory(inputs, { repoSlug, issue, pr, round, registry, observedAt }),
    prompt: buildFindingEnvelopePrompt,
    parse: (output, inventory) => parseFindingEnvelope(output, inventory, registry),
    writeUnknown: () => safeWrite(projectUnknownSummary({ issue, pr, round, observedAt, registry, repoSlug })),
    writePartial: (inventory) => safeWrite(projectFindingObservations(inventory, null, { partial: true })),
    writeComplete: (inventory, parsed) => safeWrite(projectFindingObservations(inventory, parsed)),
  };
}
