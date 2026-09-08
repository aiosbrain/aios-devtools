// Opt-in finding-observation producer for consolidate-findings (AIO-1100).
// This leaf owns sanitization, identity, validation, and the fail-closed local writer.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFindingSeverityRecords } from "./finding-severity-records.mjs";
import { extractCodeRabbitFindingRecords } from "./coderabbit-finding-records.mjs";
import { checkIsPending, checkIsRed, sanitizedCheckIdentity } from "./ci-status.mjs";
import { acquireAtomicJsonlLease, releaseAtomicJsonlLease, writeAtomicJsonl } from "./atomic-jsonl.mjs";
import { validateFindingLedger } from "./finding-observation-validator.mjs";
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
const DECISION_KEYS = new Set([
  "source_key", "outcome", "duplicate_target", "codebases", "taxonomy", "evidence_status",
]);
const TAXONOMY_KEYS = new Set(["severity", "defect_class", "determinism", "fences"]);
const LINKS = Object.freeze({ linear: null, scanner: null, pull_request: null, merge: null, resolution: null });

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const members = Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [JSON.stringify(key), canonical(value[key])].join(":"));
    return ["{", members.join(","), "}"].join("");
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
  const m = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/.exec(String(issue));
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
    evidence_sha256: sha256(canonical({ kind: "text-finding", line, severity: severity.toLowerCase() })),
    evidence_end_offset: found[index + 1] ? starts[found[index + 1].line - 1] : source.length,
    source_locator: { kind: "line", line },
  }));
}

function codeRabbitTimestamp(value, key) {
  if (value[key] === undefined) return null;
  if (typeof value[key] !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value[key])) {
    throw new Error(`unsafe CodeRabbit ${key}`);
  }
  return value[key];
}

function codeRabbitState(value) {
  if (value.state === undefined) return null;
  if (typeof value.state !== "string" || !/^[A-Z_]{1,32}$/.test(value.state)) {
    throw new Error("unsafe CodeRabbit state");
  }
  return value.state;
}

function codeRabbitPath(value) {
  if (value.path === undefined) return null;
  if (typeof value.path !== "string" || value.path.length > 500 || value.path.startsWith("/")
    || /(^|\/)\.\.(\/|$)|[\u0000-\u001f]|=/.test(value.path)) throw new Error("unsafe CodeRabbit path");
  const at = value.path.indexOf("@");
  const dot = value.path.indexOf(".", at + 2);
  const slash = value.path.indexOf("/", at + 1);
  if (at > 0 && dot > at + 1 && (slash < 0 || slash > dot)) throw new Error("unsafe CodeRabbit path");
  return value.path;
}

function codeRabbitItemIdentity(value) {
  const identity = {};
  if (value.id !== undefined) {
    if (!Number.isInteger(value.id) || value.id < 1) throw new Error("unsafe CodeRabbit id");
    identity.id = value.id;
  }
  const itemPath = codeRabbitPath(value);
  if (itemPath !== null) identity.path = itemPath;
  if (value.line !== undefined && value.line !== null) {
    if (!Number.isInteger(value.line) || value.line < 1) throw new Error("unsafe CodeRabbit line");
    identity.line = value.line;
  }
  const createdAt = codeRabbitTimestamp(value, "created_at");
  const submittedAt = codeRabbitTimestamp(value, "submitted_at");
  const state = codeRabbitState(value);
  if (createdAt !== null) identity.created_at = createdAt;
  if (submittedAt !== null) identity.submitted_at = submittedAt;
  if (state !== null) identity.state = state;
  const fields = Object.keys(identity).sort((left, right) => left.localeCompare(right));
  return sha256(canonical({ fields, id: identity.id ?? null, line: identity.line ?? null,
    path: identity.path ?? null, created_at: createdAt, submitted_at: submittedAt, state }));
}

function codeRabbitSource(sourceType, items) {
  const records = [];
  let malformed = 0;
  for (const [itemIndex, item] of (items ?? []).entries()) {
    if (!item || typeof item !== "object" || (item.body !== undefined && typeof item.body !== "string")) {
      malformed++;
      continue;
    }
    try {
      const digest = (value) => sha256(canonical(value));
      records.push(...extractCodeRabbitFindingRecords(item.body, itemIndex, codeRabbitItemIdentity(item), digest));
    } catch {
      malformed++;
    }
  }
  return { source: { source_type: sourceType, records }, malformed };
}

function ciSource(checks) {
  const ci = [];
  let malformed = 0;
  for (const [item, check] of (checks ?? []).entries()) {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      malformed++;
      continue;
    }
    let classification = null;
    if (checkIsRed(check)) classification = "red";
    else if (checkIsPending(check)) classification = "pending";
    if (!classification) continue;
    try {
      const check_identity_sha256 = sha256(canonical(sanitizedCheckIdentity(check)));
      const severity = classification === "red" ? "high" : "unknown";
      ci.push({ severity,
        evidence_sha256: sha256(canonical({ classification, check_identity_sha256 })), source_locator: { kind: "check", item } });
    } catch {
      malformed++;
    }
  }
  return { source: { source_type: "ci", records: ci }, malformed };
}

function candidatesForSource({ source_type, records }) {
  const ordered = [...records].sort((a, b) => a.evidence_sha256.localeCompare(b.evidence_sha256) || a.severity.localeCompare(b.severity));
  const digestRecords = ordered.map(({ severity, evidence_sha256 }) => ({ severity, evidence_sha256 }));
  const source_artifact_sha256 = sha256(canonical({ source_type, records: digestRecords }));
  return ordered.map(({ severity, evidence_sha256, source_locator, evidence_available = true }, source_position) => {
    const source_key = sha256(canonical({ source_type, source_artifact_sha256, source_local_position: source_position }));
    return { source_type, source_position, severity, evidence_sha256, source_artifact_sha256, source_key, source_locator, evidence_available };
  });
}

function makeInventoryRecords(inputs) {
  if (!inputs.checks?.checks?.length && (inputs.checks?.ciRed || inputs.checks?.ciPending)) {
    throw new Error("plaintext CI evidence has no trustworthy candidate denominator");
  }
  const visibleChars = inputs.gptObservationVisibleChars ?? Number.POSITIVE_INFINITY;
  const gptRecords = textFindingRecords(inputs.gptObservationMarkdown ?? inputs.gptMarkdown, "gpt")
    .map((record) => ({ ...record, evidence_available: record.evidence_end_offset <= visibleChars }));
  const gathered = [
    { source: { source_type: "local-bugbot", records: textFindingRecords(inputs.localBugbotMarkdown) }, malformed: 0 },
    { source: { source_type: "gpt", records: gptRecords }, malformed: 0 },
    codeRabbitSource("coderabbit-issue", inputs.issueComments),
    codeRabbitSource("coderabbit-inline", inputs.inlineComments),
    codeRabbitSource("coderabbit-review", inputs.reviews),
    ciSource(inputs.checks?.checks),
  ];
  const malformed = gathered.reduce((total, result) => total + result.malformed, 0);
  const candidates = gathered.flatMap((result) => candidatesForSource(result.source))
    .sort((a, b) => a.source_key.localeCompare(b.source_key));
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
  const head = inputs.latestCommit?.sha ?? null;
  if (head !== null && !/^[0-9a-f]{40}$/i.test(head)) throw new Error("inventory head revision is invalid");
  const runSeed = { issue, pr: Number(pr), round, head: head?.toLowerCase() ?? null, detector_evidence_sha256, observed_at: at };
  return {
    capture_status: "complete", detector_completed: true, detector_evidence_sha256,
    raw_candidates: candidates.length + malformed, malformed, candidates, codebase, issue_ref: issueRef, observed_at: at,
    run_id: sha256(canonical(runSeed)), program_id: sha256(canonical({ issue, codebase })),
    attribution_run_id: sha256(canonical({ issue, pr: Number(pr), round, head: head?.toLowerCase() ?? null, observed_at: at })), attempt: round,
    allowed_codebases: [...new Set(Object.values(registry.codebase_mappings))]
      .sort((left, right) => left.localeCompare(right)),
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

function validateDecisionCodebases(decision, registered, inventory) {
  if (!Array.isArray(decision.codebases) || !decision.codebases.length
    || decision.codebases.some((codebase) => !registered.has(codebase))) {
    throw new Error(`unregistered codebase decision for ${decision.source_key}`);
  }
  const sortedCodebases = [...new Set(decision.codebases)]
    .sort((left, right) => left.localeCompare(right));
  if (canonical(sortedCodebases) !== canonical(decision.codebases)) {
    throw new Error(`codebases must be sorted and unique for ${decision.source_key}`);
  }
  if (!sortedCodebases.includes(inventory.codebase)) {
    throw new Error(`decision omits source codebase for ${decision.source_key}`);
  }
  return sortedCodebases;
}

function validateDecisionTaxonomy(decision) {
  exactKeys(decision.taxonomy, TAXONOMY_KEYS, "taxonomy");
  const taxonomy = decision.taxonomy;
  if (!TAXONOMY.severity.has(taxonomy.severity) || !TAXONOMY.defect_class.has(taxonomy.defect_class)
    || !TAXONOMY.determinism.has(taxonomy.determinism)) {
    throw new Error(`invalid taxonomy for ${decision.source_key}`);
  }
  const fences = taxonomy.fences;
  const ordered = Array.isArray(fences)
    ? [...new Set(fences)].sort((left, right) => left.localeCompare(right))
    : [];
  const exclusiveFence = fences?.length > 1 && (fences.includes("none") || fences.includes("unknown"));
  if (!fences?.length || fences.some((fence) => !TAXONOMY.fences.has(fence))
    || canonical(ordered) !== canonical(fences) || exclusiveFence) {
    throw new Error(`invalid taxonomy fences for ${decision.source_key}`);
  }
}

function validateDecisionOutcome(decision, expected) {
  if (!OUTCOMES.has(decision.outcome)) throw new Error(`invalid outcome for ${decision.source_key}`);
  const evidenceStatuses = new Set(["complete", "incomplete", "unknown"]);
  if (!evidenceStatuses.has(decision.evidence_status)) {
    throw new Error(`invalid evidence status for ${decision.source_key}`);
  }
  const incomplete = decision.outcome === "incomplete";
  if ((incomplete && decision.evidence_status === "complete") || (!incomplete && decision.evidence_status !== "complete")) {
    throw new Error(`outcome/evidence mismatch for ${decision.source_key}`);
  }
  if (decision.outcome === "duplicate") {
    if (!expected.has(decision.duplicate_target) || decision.duplicate_target === decision.source_key) {
      throw new Error(`invalid duplicate target for ${decision.source_key}`);
    }
  } else if (decision.duplicate_target !== null) {
    throw new Error(`unexpected duplicate target for ${decision.source_key}`);
  }
}

function validateDecisionGraph(byKey, expected) {
  for (const start of expected) {
    const seen = new Set([start]);
    let cursor = start;
    while (byKey.get(cursor)?.outcome === "duplicate") {
      cursor = byKey.get(cursor).duplicate_target;
      if (seen.has(cursor)) throw new Error("duplicate decisions contain a cycle");
      seen.add(cursor);
    }
  }
}

export function parseFindingEnvelope(output, inventory, registry) {
  let envelope;
  try { envelope = JSON.parse(String(output)); } catch { throw new Error("model response is not a strict JSON envelope"); }
  exactKeys(envelope, new Set(["report_markdown", "decisions"]), "model envelope");
  if (typeof envelope.report_markdown !== "string" || !Array.isArray(envelope.decisions)) throw new Error("invalid model envelope shape");
  const expected = new Set(inventory.candidates.map((c) => c.source_key));
  const candidates = new Map(inventory.candidates.map((candidate) => [candidate.source_key, candidate]));
  const registered = new Set(Object.values(registry.codebase_mappings));
  const byKey = new Map();
  for (const decision of envelope.decisions) {
    exactKeys(decision, DECISION_KEYS, "decision");
    if (!expected.has(decision.source_key)) throw new Error(`invented source key: ${decision.source_key}`);
    if (byKey.has(decision.source_key)) throw new Error(`repeated source key: ${decision.source_key}`);
    if (!candidates.get(decision.source_key).evidence_available && decision.outcome !== "incomplete") {
      throw new Error(`decision claims unavailable evidence for ${decision.source_key}`);
    }
    const sortedCodebases = validateDecisionCodebases(decision, registered, inventory);
    validateDecisionTaxonomy(decision);
    validateDecisionOutcome(decision, expected);
    byKey.set(decision.source_key, { ...decision, codebases: sortedCodebases });
  }
  if (byKey.size !== expected.size) throw new Error("model decisions do not account for every source key");
  validateDecisionGraph(byKey, expected);
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

function dispositionForState(state) {
  if (state === "duplicate") return "duplicate";
  if (state === "rejected") return "rejected";
  if (state === "incomplete") return "unknown";
  return "open";
}

function eventRecord(inventory, source, base, state, sequence, predecessor, decision = null) {
  const codebases = decision?.codebases ?? [inventory.codebase];
  const taxonomy = decision?.taxonomy ?? { severity: source.severity, defect_class: "unknown", determinism: "unknown", fences: ["unknown"] };
  let evidence = decision?.evidence_status;
  if (!evidence) evidence = state === "discovered" ? "complete" : "incomplete";
  const disposition = dispositionForState(state);
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

export function validateFindingObservations(records, registry) {
  return validateFindingLedger(records, registry, {
    canonical,
    sha256,
    schemaPath: SCHEMA_PATH,
    pinPath: PIN_PATH,
    schemaSha256: SCHEMA_SHA256,
    eventId: findingEventId,
    candidateId: (identity) => domainHash(DOMAIN_CANDIDATE, identity),
  });
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
  const lease = acquireAtomicJsonlLease(outputPath);
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
    close: () => releaseAtomicJsonlLease(lease),
  };
}
