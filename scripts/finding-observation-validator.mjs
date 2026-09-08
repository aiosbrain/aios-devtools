// Structural, semantic, lifecycle, and reconciliation validation for finding ledgers.
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

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
  ["duplicate", new Set(["reopened"])],
  ["rejected", new Set(["reopened"])],
  ["incomplete", new Set(["reopened"])],
  ["reopened", new Set(["verified", "duplicate", "rejected", "incomplete"])],
]);

const TERMINAL = new Map([
  ["discovery", new Set(["verified", "filed", "queue_eligible", "selected", "remediation_started", "merged", "resolved", "duplicate", "rejected"])],
  ["filing", new Set(["filed", "queue_eligible", "selected", "remediation_started", "merged", "resolved", "duplicate", "rejected"])],
  ["remediation", new Set(["merged", "resolved", "duplicate", "rejected"])],
  ["resolution", new Set(["resolved", "duplicate", "rejected"])],
]);

function validCalendarTimestamp(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().replace(/\.000Z$/, "Z") === value;
}

function expectedDisposition(state) {
  if (state === "duplicate") return "duplicate";
  if (state === "rejected") return "rejected";
  if (state === "resolved") return "resolved";
  if (state === "incomplete") return "unknown";
  return "open";
}

function validateSchemaPin(context) {
  const schemaBytes = readFileSync(context.schemaPath);
  const pin = readFileSync(context.pinPath, "utf8").trim().split(/\s+/)[0];
  if (pin !== context.schemaSha256 || context.sha256(schemaBytes) !== pin) {
    throw new Error("packaged finding schema hash mismatch");
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true, formats: { "date-time": true } });
  return { ajv, validate: ajv.compile(JSON.parse(schemaBytes)) };
}

function validateRecordBasis(record, registry, context, schema) {
  if (!schema.validate(record)) {
    throw new Error(`finding observation schema error: ${schema.ajv.errorsText(schema.validate.errors)}`);
  }
  if (!validCalendarTimestamp(record.observed_at)) throw new Error("finding observation has invalid calendar timestamp");
  const { event_id, ...withoutId } = record;
  if (event_id !== context.eventId(withoutId)) throw new Error("finding observation event_id mismatch");
  if (record.producer.name !== registry.producer.name || !registry.producer.versions.includes(record.producer.version)) {
    throw new Error("finding observation producer is untrusted");
  }
  if (record.attribution.issue && !registry.linear_teams.includes(record.attribution.issue.team)) {
    throw new Error("finding observation team is untrusted");
  }
}

function validateCandidateRecord(record, registry, context) {
  const sortedCodebases = [...record.codebases].sort((left, right) => left.localeCompare(right));
  const registered = new Set(Object.values(registry.codebase_mappings));
  if (context.canonical(sortedCodebases) !== context.canonical(record.codebases)
    || record.codebases.some((codebase) => !registered.has(codebase))) {
    throw new Error("finding observation codebase is untrusted or unsorted");
  }
  if (record.candidate_id !== context.candidateId(record.identity)) throw new Error("finding observation candidate_id mismatch");
  if (record.identity.producer_namespace !== record.producer.name
    || record.identity.original_run_id !== record.producer.run_id) {
    throw new Error("finding discovery provenance is inconsistent");
  }
  if (record.disposition !== expectedDisposition(record.state)) throw new Error("finding disposition does not match state");
  const invalidIncompleteEvidence = record.state === "incomplete" && record.evidence_status === "complete";
  const invalidTerminalEvidence = record.state !== "incomplete" && record.sequence > 0 && record.evidence_status !== "complete";
  if (invalidIncompleteEvidence || invalidTerminalEvidence) throw new Error("finding evidence does not match lifecycle state");
  if (record.links.pull_request && !record.codebases.includes(record.links.pull_request.codebase)) {
    throw new Error("finding pull request is outside codebase membership");
  }
  if (record.duplicate_target !== null && record.state !== "duplicate") {
    throw new Error("duplicate target exists outside duplicate state");
  }
  const fences = record.taxonomy.fences;
  const sortedFences = [...new Set(fences)].sort((left, right) => left.localeCompare(right));
  const mixedExclusiveFence = fences.length > 1 && (fences.includes("none") || fences.includes("unknown"));
  if (context.canonical(sortedFences) !== context.canonical(fences) || mixedExclusiveFence) {
    throw new Error("finding taxonomy fences are invalid");
  }
}

function collectRecords(records, registry, context, schema) {
  const candidates = new Map();
  let summary = null;
  let provenance = null;
  for (const record of records) {
    validateRecordBasis(record, registry, context, schema);
    const recordProvenance = context.canonical({ producer: record.producer, attribution: record.attribution });
    if (provenance !== null && provenance !== recordProvenance) {
      throw new Error("finding observation run provenance is inconsistent");
    }
    provenance = recordProvenance;
    if (record.record_type === "run_summary") {
      if (summary && summary.event_id !== record.event_id) throw new Error("conflicting run summaries");
      summary = record;
      continue;
    }
    validateCandidateRecord(record, registry, context);
    const list = candidates.get(record.candidate_id) ?? [];
    list.push(record);
    candidates.set(record.candidate_id, list);
  }
  if (!summary) throw new Error("finding observation summary is required");
  return { candidates, summary };
}

function validateCandidateChains(candidates, context) {
  for (const list of candidates.values()) {
    list.sort((left, right) => left.sequence - right.sequence);
    const first = list[0];
    if (first.sequence !== 0 || first.state !== "discovered" || first.predecessor_event_id !== null) {
      throw new Error("invalid discovery lifecycle");
    }
    for (let index = 1; index < list.length; index++) {
      const current = list[index];
      const previous = list[index - 1];
      if (current.sequence !== index || current.predecessor_event_id !== previous.event_id
        || context.canonical(current.identity) !== context.canonical(first.identity)) {
        throw new Error("invalid finding lifecycle chain");
      }
      if (!TRANSITIONS.get(previous.state)?.has(current.state)) {
        throw new Error(`illegal finding transition: ${previous.state} -> ${current.state}`);
      }
      const expectedEpisode = current.state === "reopened" ? previous.episode + 1 : previous.episode;
      if (current.episode !== expectedEpisode) throw new Error("invalid finding lifecycle episode");
    }
    const duplicate = list.find((record) => record.state === "duplicate");
    if (duplicate && (!candidates.has(duplicate.duplicate_target) || duplicate.duplicate_target === duplicate.candidate_id)) {
      throw new Error("duplicate target is unknown or self-referential");
    }
  }
}

function validateDuplicateGraph(candidates) {
  for (const start of candidates.keys()) {
    const seen = new Set([start]);
    let cursor = start;
    for (;;) {
      const edge = candidates.get(cursor)?.find((record) => record.state === "duplicate")?.duplicate_target;
      if (!edge) break;
      if (seen.has(edge)) throw new Error("finding duplicate graph contains a cycle");
      seen.add(edge);
      cursor = edge;
    }
  }
}

function validateKnownSummary(summary, candidates) {
  const counts = summary.counts;
  const terminalStates = TERMINAL.get(summary.stage);
  const terminal = [...candidates.values()]
    .filter((list) => terminalStates.has(list.at(-1).state)).length;
  const reconciled = counts.raw_candidates === counts.terminal_stage + counts.incomplete
    && counts.raw_candidates - counts.emitted_candidates === counts.malformed
    && counts.incomplete === counts.emitted_candidates - counts.terminal_stage + counts.malformed
    && counts.emitted_candidates === candidates.size
    && counts.terminal_stage === terminal;
  const expectedGap = counts.malformed ? "malformed" : "none";
  if (!reconciled || summary.emission_gap_reason !== expectedGap) {
    throw new Error("finding observation summary reconciliation failed");
  }
}

function validateSummary(summary, candidates) {
  if (summary.capture_status !== "unknown") {
    validateKnownSummary(summary, candidates);
    return;
  }
  const claimsCounts = Object.values(summary.counts).some((value) => value !== null);
  if (summary.detector_completed !== null || summary.detector_evidence_sha256 !== null
    || claimsCounts || summary.emission_gap_reason !== "unknown") {
    throw new Error("unknown capture must not claim a denominator");
  }
}

export function validateFindingLedger(records, registry, context) {
  const schema = validateSchemaPin(context);
  const { candidates, summary } = collectRecords(records, registry, context, schema);
  validateCandidateChains(candidates, context);
  validateDuplicateGraph(candidates);
  validateSummary(summary, candidates);
  return true;
}
