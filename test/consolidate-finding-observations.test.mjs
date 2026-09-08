import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SCHEMA_PATH,
  SCHEMA_SHA256,
  PIN_PATH,
  PRODUCER_VERSION,
  buildFindingEnvelopePrompt,
  canonical,
  findingEventId,
  loadFindingRegistry,
  normalizeFindingInventory,
  parseFindingEnvelope,
  projectFindingObservations,
  projectUnknownSummary,
  sha256,
  validateFindingObservations,
  writeFindingObservations,
} from "../scripts/finding-observations.mjs";
import { extractFindingSeverityRecords } from "../scripts/finding-severity-records.mjs";
import { hasCriticalOrHighFindings } from "../scripts/severity.mjs";
import { cmdConsolidateFindings } from "../scripts/consolidate-findings.mjs";
import { parseCheckResults } from "../scripts/consolidate-findings.mjs";

const registry = loadFindingRegistry();
const BASE_INPUTS = {
  localBugbotMarkdown: "- High: unsafe retry\n",
  gptMarkdown: "- `Low` `README.md`: typo\n",
  issueComments: [{ body: "_⚠️ Potential issue_ **Major:** null crash" }],
  inlineComments: [], reviews: [],
  checks: { checks: [{ name: "build", state: "FAILURE", bucket: "fail" }] },
  latestCommit: { sha: "a".repeat(40), committed_at: "2026-09-08T00:00:00Z" },
};
const opts = { repoSlug: "aiosbrain/aios-devtools", issue: "AIO-1100", pr: 44, round: 1, registry };
const decision = (source, override = {}) => ({
  source_key: source.source_key,
  outcome: "verified",
  duplicate_target: null,
  codebases: ["aios-devtools"],
  taxonomy: { severity: source.severity, defect_class: "unknown", determinism: "unverified", fences: ["none"] },
  evidence_status: "complete",
  ...override,
});
const envelope = (inventory, transform = (d) => d) => JSON.stringify({
  report_markdown: "## Verdict\n\nBLOCKED\n",
  decisions: inventory.candidates.map((source) => transform(decision(source), source)),
});

test("vendored AIO-1098 schema has the exact published hash", () => {
  assert.equal(sha256(readFileSync(SCHEMA_PATH)), SCHEMA_SHA256);
  assert.equal(readFileSync(PIN_PATH, "utf8").trim().split(/\s+/)[0], SCHEMA_SHA256);
  assert.equal(PRODUCER_VERSION, JSON.parse(readFileSync(path.join(path.dirname(SCHEMA_PATH), "..", "package.json"), "utf8")).version);
  assert.equal(registry.producer.versions.includes(PRODUCER_VERSION), true);
  const untrustedPath = path.join(mkdtempSync(path.join(tmpdir(), "finding-registry-")), "registry.json");
  writeFileSync(untrustedPath, JSON.stringify({ ...registry, producer: { ...registry.producer, versions: ["0.0.0"] } }));
  assert.throws(() => loadFindingRegistry(untrustedPath), /is not trusted/);
});

test("normalizes every supported dialect and projects a reconciled ledger", () => {
  const inventory = normalizeFindingInventory(BASE_INPUTS, opts);
  assert.equal(inventory.raw_candidates, 4);
  assert.deepEqual([...new Set(inventory.candidates.map((x) => x.source_type))].sort(), ["ci", "coderabbit-issue", "gpt", "local-bugbot"]);
  const parsed = parseFindingEnvelope(envelope(inventory), inventory, registry);
  const records = projectFindingObservations(inventory, parsed);
  assert.equal(validateFindingObservations(records, registry), true);
  assert.equal(records.filter((x) => x.record_type === "candidate").length, 8);
  assert.deepEqual(records.at(-1).counts, { raw_candidates: 4, emitted_candidates: 4, terminal_stage: 4, incomplete: 0, malformed: 0 });
  assert.equal(records.every((x) => !canonical(x).includes("unsafe retry")), true);
  assert.equal(records.every((x) => x.visibility_tier === "team"), true);
});

test("splits bundled CodeRabbit findings and accepts legacy Bugbot severity headings", () => {
  const inputs = {
    ...BASE_INPUTS,
    localBugbotMarkdown: "**High Severity**\n\nRetry never stops.\n",
    gptMarkdown: null,
    issueComments: [{ body: "**Major:** crash\n\n**Minor:** confusing fallback" }],
    checks: { checks: [] },
  };
  const inventory = normalizeFindingInventory(inputs, opts);
  assert.equal(inventory.raw_candidates, 3);
  assert.deepEqual(inventory.candidates.map((x) => x.severity).sort(), ["high", "high", "medium"]);
});

test("finding identity covers legacy heading bodies and mixed CodeRabbit dialects", () => {
  const legacy = (body) => normalizeFindingInventory({
    ...BASE_INPUTS, localBugbotMarkdown: `**High Severity**\n\n${body}\n`,
    gptMarkdown: null, issueComments: [], checks: { checks: [] },
  }, opts);
  assert.notEqual(legacy("Retry loops forever.").candidates[0].source_key, legacy("Credentials are exposed.").candidates[0].source_key);
  const mixed = normalizeFindingInventory({
    ...BASE_INPUTS, localBugbotMarkdown: "BUGBOT_CLEAR", gptMarkdown: null,
    issueComments: [{ body: "**Major:** first defect\n\n[Low] README.md:1 — second defect" }], checks: { checks: [] },
  }, opts);
  assert.deepEqual(mixed.candidates.map((x) => x.severity).sort(), ["high", "low"]);
  for (const [body, severity] of [["_🧹 Nitpick_\n\nRename this variable.", "low"], ["**Minor** wording issue", "medium"]]) {
    const inventory = normalizeFindingInventory({
      ...BASE_INPUTS, localBugbotMarkdown: "BUGBOT_CLEAR", gptMarkdown: null,
      issueComments: [{ body }], checks: { checks: [] },
    }, opts);
    assert.deepEqual(inventory.candidates.map((x) => x.severity), [severity]);
  }
  const oneFinding = normalizeFindingInventory({
    ...BASE_INPUTS, localBugbotMarkdown: "BUGBOT_CLEAR", gptMarkdown: null, checks: { checks: [] },
    issueComments: [{ body: "_⚠️ Potential issue_\n\n**Major:** Null input crashes.\n\nThis is a minor change to the guard." }],
  }, opts);
  assert.deepEqual(oneFinding.candidates.map((x) => x.severity), ["high"]);
  const bundled = normalizeFindingInventory({
    ...BASE_INPUTS, localBugbotMarkdown: "BUGBOT_CLEAR", gptMarkdown: null, checks: { checks: [] }, issueComments: [],
    reviews: [{ body: "_⚠️ Potential issue_ | _🟠 Major_\n\n**Null input crashes.**\n\n_⚠️ Potential issue_ | _🟡 Minor_\n\n**Fallback is incorrect.**" }],
  }, opts);
  assert.deepEqual(bundled.candidates.map((x) => x.severity).sort(), ["high", "medium"]);
});

test("opt-in inventory preserves GPT findings beyond the model prompt cap", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "finding-gpt-cap-"));
  const review = path.join(repo, "bugbot.md"); writeFileSync(review, "BUGBOT_CLEAR\n");
  const gptReview = path.join(repo, "gpt.md"); writeFileSync(gptReview, `${"x".repeat(21000)}\n- \`High\` late finding\n`);
  const { gatherInputs, GPT_REVIEW_CAP } = await import("../scripts/consolidate-findings.mjs");
  const runGh = (argv) => {
    if (argv[0] === "pr" && argv[1] === "checks") return { code: 0, stdout: "[]", stderr: "" };
    if (argv[0] === "api" && argv[1].endsWith("/commits")) return JSON.stringify(BASE_INPUTS.latestCommit);
    if (argv[0] === "pr" && argv[1] === "diff") return "diff";
    return "[]";
  };
  const inputs = gatherInputs({ runGh, slug: "aiosbrain/aios-devtools", pr: 44, localBugbotReviewPath: review, gptReviewPath: gptReview, preserveFullGpt: true });
  assert.equal(inputs.gptMarkdown.length < inputs.gptObservationMarkdown.length, true);
  assert.equal(inputs.gptMarkdown.includes(`truncated at ${GPT_REVIEW_CAP}`), true);
  const inventory = normalizeFindingInventory(inputs, opts);
  assert.deepEqual(inventory.candidates.map((x) => x.severity), ["high"]);
  assert.equal(inventory.candidates[0].evidence_available, false);
  assert.throws(() => parseFindingEnvelope(envelope(inventory), inventory, registry), /claims unavailable evidence/);
  const incomplete = envelope(inventory, (value) => ({ ...value, outcome: "incomplete", evidence_status: "unknown" }));
  assert.equal(parseFindingEnvelope(incomplete, inventory, registry).decisions.size, 1);
});

test("inventory uses the verdict's complete structured CI classification", () => {
  for (const [state, severity] of [["ACTION_REQUIRED", "high"], ["STARTUP_FAILURE", "high"], ["REQUESTED", "unknown"], ["WAITING", "unknown"]]) {
    const checks = parseCheckResults(JSON.stringify([{ name: state, state }]));
    const inventory = normalizeFindingInventory({
      ...BASE_INPUTS, localBugbotMarkdown: "BUGBOT_CLEAR", gptMarkdown: null, issueComments: [], checks,
    }, opts);
    assert.equal(inventory.raw_candidates, 1);
    assert.equal(inventory.candidates[0].severity, severity);
  }
});

test("does not double-count overlapping CodeRabbit severity syntax", () => {
  const inputs = { ...BASE_INPUTS, localBugbotMarkdown: "BUGBOT_CLEAR", gptMarkdown: null, issueComments: [{ body: "**High:** SQL injection" }], checks: { checks: [] } };
  assert.equal(normalizeFindingInventory(inputs, opts).raw_candidates, 1);
});

test("plaintext red CI cannot claim a trustworthy zero denominator", () => {
  const checks = parseCheckResults("build  fail  1m  https://example.invalid");
  assert.equal(checks.ciRed, true); assert.equal(checks.checks.length, 0);
  assert.throws(() => normalizeFindingInventory({ ...BASE_INPUTS, localBugbotMarkdown: "BUGBOT_CLEAR", gptMarkdown: null, issueComments: [], checks }, opts), /trustworthy candidate denominator/);
});

test("captures bracketed, table, and emphasized canonical Bugbot records", () => {
  const inputs = {
    ...BASE_INPUTS,
    localBugbotMarkdown: "[High] scripts/x.mjs:1 — boom\n| Medium | x |\n- **Low**: note\n",
    gptMarkdown: null, issueComments: [], checks: { checks: [] },
  };
  const inventory = normalizeFindingInventory(inputs, opts);
  assert.deepEqual(inventory.candidates.map((x) => x.severity).sort(), ["high", "low", "medium"]);
  assert.deepEqual(inventory.candidates.map((x) => x.source_position).sort(), [0, 1, 2]);
});

test("inventory uses the canonical severity records for compact bullets, headings, and GPT", () => {
  const compact = "-Critical: scripts/x.mjs:12 — auth bypass";
  assert.equal(hasCriticalOrHighFindings(compact), true);
  assert.deepEqual(extractFindingSeverityRecords(compact).map((x) => x.severity), ["Critical"]);
  const compactInventory = normalizeFindingInventory({ ...BASE_INPUTS, localBugbotMarkdown: compact, gptMarkdown: null, issueComments: [], checks: { checks: [] } }, opts);
  assert.deepEqual(compactInventory.candidates.map((x) => x.severity), ["critical"]);
  const changedInventory = normalizeFindingInventory({ ...BASE_INPUTS, localBugbotMarkdown: "- Critical: scripts/x.mjs:12 — different defect", gptMarkdown: null, issueComments: [], checks: { checks: [] } }, opts);
  assert.notEqual(changedInventory.candidates[0].source_key, compactInventory.candidates[0].source_key);

  const heading = "### [High] scripts/x.mjs:12 — not a canonical finding";
  assert.equal(hasCriticalOrHighFindings(heading), false);
  assert.equal(normalizeFindingInventory({ ...BASE_INPUTS, localBugbotMarkdown: heading, gptMarkdown: null, issueComments: [], checks: { checks: [] } }, opts).raw_candidates, 0);

  const gpt = "- `High` scripts/x.mjs: one finding";
  assert.deepEqual(extractFindingSeverityRecords(gpt, { dialect: "gpt" }).map((x) => x.severity), ["High"]);
  const gptInventory = normalizeFindingInventory({ ...BASE_INPUTS, localBugbotMarkdown: "BUGBOT_CLEAR", gptMarkdown: gpt, issueComments: [], checks: { checks: [] } }, opts);
  assert.equal(gptInventory.raw_candidates, 1);
  assert.equal(gptInventory.candidates[0].severity, "high");
});

test("source ordering and exact replay preserve identities and bytes", () => {
  const sourceInputs = { ...BASE_INPUTS, issueComments: [{ body: "**Major:** crash" }, { body: "**Minor:** docs" }] };
  const a = normalizeFindingInventory(sourceInputs, opts);
  const shuffled = { ...sourceInputs, issueComments: [...sourceInputs.issueComments].reverse(), inlineComments: [...sourceInputs.inlineComments].reverse() };
  const b = normalizeFindingInventory(shuffled, opts);
  const stableProjection = (inventory) => inventory.candidates.map(({ source_locator: _locator, ...candidate }) => candidate);
  assert.deepEqual(stableProjection(b), stableProjection(a));
  const bytesA = projectFindingObservations(a, parseFindingEnvelope(envelope(a), a, registry)).map(canonical).join("\n");
  const bytesB = projectFindingObservations(b, parseFindingEnvelope(envelope(b), b, registry)).map(canonical).join("\n");
  assert.equal(bytesB, bytesA);
  const later = normalizeFindingInventory(sourceInputs, { ...opts, observedAt: "2026-09-09T00:00:00Z" });
  assert.notEqual(later.run_id, a.run_id);
  assert.notEqual(later.attribution_run_id, a.attribution_run_id);
  assert.notEqual(projectFindingObservations(later, null, { partial: true })[0].candidate_id,
    projectFindingObservations(a, null, { partial: true })[0].candidate_id);
});

test("duplicate, rejected, incomplete, and cross-repo decisions remain one candidate each", () => {
  const custom = { ...registry, codebase_mappings: { ...registry.codebase_mappings, "test/other": "workspace" } };
  const inventory = normalizeFindingInventory(BASE_INPUTS, { ...opts, registry: custom });
  const keys = inventory.candidates.map((x) => x.source_key);
  const output = envelope(inventory, (d, source) => {
    const i = keys.indexOf(source.source_key);
    if (i === 1) return { ...d, outcome: "duplicate", duplicate_target: keys[0] };
    if (i === 2) return { ...d, outcome: "rejected" };
    if (i === 3) return { ...d, outcome: "incomplete", evidence_status: "incomplete", codebases: ["aios-devtools", "workspace"] };
    return d;
  });
  const records = projectFindingObservations(inventory, parseFindingEnvelope(output, inventory, custom));
  assert.equal(validateFindingObservations(records, custom), true);
  assert.deepEqual(records.at(-1).counts, { raw_candidates: 4, emitted_candidates: 4, terminal_stage: 3, incomplete: 1, malformed: 0 });
  assert.equal(new Set(records.filter((x) => x.record_type === "candidate").map((x) => x.candidate_id)).size, 4);
});

test("clear completion is proven zero while unavailable capture is unknown", () => {
  const clean = normalizeFindingInventory({ ...BASE_INPUTS, localBugbotMarkdown: "BUGBOT_CLEAR", gptMarkdown: null, issueComments: [], checks: { checks: [] } }, opts);
  const cleanRecords = projectFindingObservations(clean, parseFindingEnvelope(envelope(clean), clean, registry));
  assert.equal(cleanRecords.length, 1);
  assert.deepEqual(cleanRecords[0].counts, { raw_candidates: 0, emitted_candidates: 0, terminal_stage: 0, incomplete: 0, malformed: 0 });
  assert.equal(cleanRecords[0].detector_completed, true);
  const unknown = projectUnknownSummary({ issue: "AIO-1100", pr: 44, observedAt: "2026-09-08T00:00:00Z", registry, repoSlug: "aiosbrain/aios-devtools" });
  assert.equal(validateFindingObservations(unknown, registry), true);
  assert.equal(unknown[0].capture_status, "unknown");
  assert.equal(unknown[0].counts.raw_candidates, null);
  assert.equal(unknown[0].attribution.program_id, cleanRecords[0].attribution.program_id);
});

test("provider failure after capture produces discovered/incomplete partial evidence", () => {
  const inventory = normalizeFindingInventory(BASE_INPUTS, opts);
  const records = projectFindingObservations(inventory, null, { partial: true });
  assert.equal(validateFindingObservations(records, registry), true);
  assert.equal(records.at(-1).capture_status, "partial");
  assert.equal(records.at(-1).counts.incomplete, 4);
  assert.equal(records.filter((x) => x.state === "incomplete").length, 4);
});

test("loop-model resolution failure after capture writes partial observations", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "finding-model-config-"));
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  writeFileSync(path.join(repo, ".aios", "loop-models.yaml"), "consolidate_model:\n");
  const review = path.join(repo, "bugbot.md"); writeFileSync(review, "- High: unsafe retry\n");
  const out = path.join(repo, "observations.jsonl");
  const runner = path.join(repo, "run.mjs");
  const moduleUrl = new URL("../scripts/consolidate-findings.mjs", import.meta.url).href;
  writeFileSync(runner, `
    import { cmdConsolidateFindings } from ${JSON.stringify(moduleUrl)};
    const latest = ${JSON.stringify(BASE_INPUTS.latestCommit)};
    const runGh = (argv) => {
      if (argv[0] === "pr" && argv[1] === "checks") return { code: 0, stdout: "[]", stderr: "" };
      if (argv[0] === "api" && argv[1].endsWith("/commits")) return JSON.stringify(latest);
      if (argv[0] === "pr" && argv[1] === "diff") return "diff";
      return "[]";
    };
    const code = await cmdConsolidateFindings(${JSON.stringify(repo)}, ["--pr", "44", "--issue", "AIO-1100", "--repo", "aiosbrain/aios-devtools", "--local-bugbot-review", ${JSON.stringify(review)}, "--finding-observations", ${JSON.stringify(out)}], {
      runGh, readReviewerPrompt: () => "review", now: () => "2026-09-08T00:00:00Z",
    });
    process.exitCode = code;
  `);
  const child = spawnSync(process.execPath, [runner], { encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /invalid 'consolidate_model'/);
  const records = readFileSync(out, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records.at(-1).capture_status, "partial");
  assert.equal(records.some((x) => x.state === "incomplete"), true);
});

test("malformed source entries are counted without entering event value channels", () => {
  const inputs = { ...BASE_INPUTS, issueComments: [...BASE_INPUTS.issueComments, { body: { private_path: "/secret/home" } }] };
  const inventory = normalizeFindingInventory(inputs, opts);
  assert.equal(inventory.raw_candidates, 5);
  assert.equal(inventory.candidates.length, 4);
  const records = projectFindingObservations(inventory, parseFindingEnvelope(envelope(inventory), inventory, registry));
  assert.equal(validateFindingObservations(records, registry), true);
  assert.deepEqual(records.at(-1).counts, { raw_candidates: 5, emitted_candidates: 4, terminal_stage: 4, incomplete: 1, malformed: 1 });
  assert.equal(records.at(-1).emission_gap_reason, "malformed");
  assert.equal(canonical(records).includes("secret/home"), false);
});

test("semantic validator rejects a schema-valid illegal lifecycle transition", () => {
  const inventory = normalizeFindingInventory(BASE_INPUTS, opts);
  const records = projectFindingObservations(inventory, parseFindingEnvelope(envelope(inventory), inventory, registry));
  const bad = structuredClone(records);
  const terminal = bad.find((x) => x.record_type === "candidate" && x.sequence === 1);
  terminal.state = "merged"; terminal.disposition = "open";
  const { event_id: _old, ...withoutId } = terminal; terminal.event_id = findingEventId(withoutId);
  assert.throws(() => validateFindingObservations(bad, registry), /illegal finding transition/);
});

test("closed envelope rejects missing, invented, repeated, cyclic, unsafe, and unregistered decisions", () => {
  const inventory = normalizeFindingInventory(BASE_INPUTS, opts);
  const valid = JSON.parse(envelope(inventory));
  for (const mutate of [
    (x) => x.decisions.pop(),
    (x) => { x.decisions[0].source_key = "f".repeat(64); },
    (x) => x.decisions.push(x.decisions[0]),
    (x) => { x.decisions[0].excerpt = "secret"; },
    (x) => { x.decisions[0].codebases = ["unregistered"]; },
  ]) {
    const bad = structuredClone(valid); mutate(bad);
    assert.throws(() => parseFindingEnvelope(JSON.stringify(bad), inventory, registry));
  }
  const cyclic = structuredClone(valid);
  cyclic.decisions[0] = { ...cyclic.decisions[0], outcome: "duplicate", duplicate_target: cyclic.decisions[1].source_key };
  cyclic.decisions[1] = { ...cyclic.decisions[1], outcome: "duplicate", duplicate_target: cyclic.decisions[0].source_key };
  assert.throws(() => parseFindingEnvelope(JSON.stringify(cyclic), inventory, registry), /cycle/);
  assert.throws(() => parseFindingEnvelope("```json\n{}\n```", inventory, registry), /strict JSON/);
});

test("ambiguous taxonomy is represented explicitly as unknown", () => {
  const inventory = normalizeFindingInventory(BASE_INPUTS, opts);
  const parsed = parseFindingEnvelope(envelope(inventory, (d) => ({ ...d, taxonomy: { severity: "unknown", defect_class: "unknown", determinism: "unknown", fences: ["unknown"] } })), inventory, registry);
  assert.equal([...parsed.decisions.values()].every((x) => x.taxonomy.severity === "unknown"), true);
});

test("writer is atomic, mode 0600, and refuses live or young locks", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finding-writer-"));
  const out = path.join(dir, "events.jsonl");
  const inventory = normalizeFindingInventory(BASE_INPUTS, opts);
  const records = projectFindingObservations(inventory, parseFindingEnvelope(envelope(inventory), inventory, registry));
  writeFindingObservations(out, records, registry);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.equal(readFileSync(out, "utf8").endsWith("\n"), true);
  writeFileSync(`${out}.lock`, JSON.stringify({ pid: process.pid, created_at_ms: 0 }));
  assert.throws(() => writeFindingObservations(out, records, registry), /locked/);
  const old = Date.now() - 16 * 60 * 1000;
  writeFileSync(`${out}.lock`, JSON.stringify({ pid: 2147483647, created_at_ms: old }));
  assert.throws(() => writeFindingObservations(out, records, registry), /locked/);
  utimesSync(`${out}.lock`, new Date(old), new Date(old));
  chmodSync(`${out}.lock`, 0o600);
  writeFindingObservations(out, records, registry);
  writeFileSync(`${out}.lock`, JSON.stringify({ pid: 2147483647, created_at_ms: old }));
  writeFileSync(`${out}.lock.recovery`, "recovery in progress\n");
  utimesSync(`${out}.lock`, new Date(old), new Date(old));
  assert.throws(() => writeFindingObservations(out, records, registry), /locked/);
});

test("structured prompt contains opaque keys but not source prose", () => {
  const multiRegistry = { ...registry, codebase_mappings: { ...registry.codebase_mappings, "test/other": "workspace" } };
  const inventory = normalizeFindingInventory(BASE_INPUTS, { ...opts, registry: multiRegistry });
  const prompt = buildFindingEnvelopePrompt("legacy prompt contains raw evidence", inventory);
  assert.match(prompt, /Machine observation response/);
  assert.equal(prompt.includes(inventory.candidates[0].source_key), true);
  assert.equal(prompt.includes(`"source_position":${inventory.candidates[0].source_position}`), true);
  assert.equal(prompt.includes('"source_locator":'), true);
  assert.equal(prompt.includes("unsafe retry"), false);
  assert.match(prompt, /taxonomy\.fences.*sorted, unique, non-empty array/);
  assert.match(prompt, /evidence_status.*complete for verified\/duplicate\/rejected/);
  assert.equal(prompt.includes(`Allowed codebases: ${JSON.stringify([...new Set(Object.values(multiRegistry.codebase_mappings))].sort())}`), true);
  assert.equal(prompt.includes(`The required source codebase is ${JSON.stringify(inventory.codebase)}`), true);
});

test("opt-in model failure retains exit 1 and writes partial observations", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "finding-command-"));
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  const review = path.join(repo, "bugbot.md"); writeFileSync(review, "- High: unsafe retry\n");
  const out = path.join(repo, "observations.jsonl");
  const runGh = (argv) => {
    if (argv[0] === "pr" && argv[1] === "checks") return { code: 0, stdout: "[]", stderr: "" };
    if (argv[0] === "api" && argv[1].endsWith("/commits")) return JSON.stringify(BASE_INPUTS.latestCommit);
    if (argv[0] === "pr" && argv[1] === "diff") return "diff";
    return "[]";
  };
  const code = await cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-1100", "--repo", "aiosbrain/aios-devtools", "--local-bugbot-review", review, "--finding-observations", out], {
    runGh, readReviewerPrompt: () => "review", callAgent: async () => { throw new Error("provider down"); }, now: () => "2026-09-08T00:00:00Z",
  });
  assert.equal(code, 1);
  const records = readFileSync(out, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records.at(-1).capture_status, "partial");
  assert.equal(records.some((x) => x.state === "incomplete"), true);
});

test("opt-in success makes one model call and writes the model report plus validated JSONL", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "finding-success-"));
  const review = path.join(repo, "bugbot.md"); writeFileSync(review, "- Low: wording\n");
  const out = path.join(repo, "observations.jsonl"); const markdown = path.join(repo, "findings.md");
  const runGh = (argv) => {
    if (argv[0] === "pr" && argv[1] === "checks") return { code: 0, stdout: "[]", stderr: "" };
    if (argv[0] === "api" && argv[1].endsWith("/commits")) return JSON.stringify(BASE_INPUTS.latestCommit);
    if (argv[0] === "pr" && argv[1] === "diff") return "diff";
    return "[]";
  };
  let calls = 0;
  const code = await cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-1100", "--repo", "aiosbrain/aios-devtools", "--local-bugbot-review", review, "--out", markdown, "--finding-observations", out], {
    runGh, readReviewerPrompt: () => "review", now: () => "2026-09-09T00:00:00Z",
    callAgent: async (prompt) => {
      calls++;
      const opaque = JSON.parse(prompt.match(/Opaque inventory: (\[[^\n]+\])/)[1]);
      return JSON.stringify({ report_markdown: "## Verdict\n\nCLEAR\n\nBUGBOT_CLEAR\n", decisions: opaque.map((x) => ({ source_key: x.source_key, outcome: "verified", duplicate_target: null, codebases: ["aios-devtools"], taxonomy: { severity: "low", defect_class: "docs", determinism: "deterministic", fences: ["none"] }, evidence_status: "complete" })) });
    },
  });
  assert.equal(code, 0); assert.equal(calls, 1);
  assert.equal(readFileSync(markdown, "utf8"), "## Verdict\n\nCLEAR\n\nBUGBOT_CLEAR\n");
  const records = readFileSync(out, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(validateFindingObservations(records, registry), true);
  assert.equal(records.at(-1).counts.terminal_stage, 1);
  assert.equal(records.every((record) => record.observed_at === "2026-09-09T00:00:00Z"), true);

  const blockedMarkdown = path.join(repo, "blocked.md");
  const blockedCode = await cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-1100", "--repo", "aiosbrain/aios-devtools", "--local-bugbot-review", review, "--out", blockedMarkdown, "--finding-observations", out], {
    runGh, readReviewerPrompt: () => "review", now: () => "2026-09-09T00:00:00Z",
    callAgent: async (prompt) => {
      const opaque = JSON.parse(prompt.match(/Opaque inventory: (\[[^\n]+\])/)[1]);
      return JSON.stringify({ report_markdown: "## Verdict\n\nCLEAR\n\nBUGBOT_CLEAR\n", decisions: opaque.map((x) => ({ source_key: x.source_key, outcome: "verified", duplicate_target: null, codebases: ["aios-devtools"], taxonomy: { severity: "high", defect_class: "logic", determinism: "deterministic", fences: ["none"] }, evidence_status: "complete" })) });
    },
  });
  assert.equal(blockedCode, 3);
  assert.match(readFileSync(blockedMarkdown, "utf8"), /\[High\].*source reported a High finding/i);
  assert.equal(readFileSync(blockedMarkdown, "utf8").includes("BUGBOT_CLEAR"), false);
});

test("pre-inventory gather failure writes an unknown summary and keeps exit 1", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "finding-unknown-"));
  const review = path.join(repo, "bugbot.md"); writeFileSync(review, "BUGBOT_CLEAR\n");
  const out = path.join(repo, "observations.jsonl");
  const code = await cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-1100", "--repo", "aiosbrain/aios-devtools", "--local-bugbot-review", review, "--finding-observations", out], {
    runGh: () => { throw new Error("github unavailable"); }, readReviewerPrompt: () => "review", now: () => "2026-09-08T00:00:00Z",
  });
  assert.equal(code, 1);
  const summary = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(summary.capture_status, "unknown"); assert.equal(summary.counts.raw_candidates, null);
});

test("legacy path never evaluates observation-only clock dependency", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "finding-legacy-clock-"));
  const review = path.join(repo, "bugbot.md"); writeFileSync(review, "BUGBOT_CLEAR\n");
  const runGh = (argv) => {
    if (argv[0] === "pr" && argv[1] === "checks") return { code: 0, stdout: "[]", stderr: "" };
    if (argv[0] === "api" && argv[1].endsWith("/commits")) return JSON.stringify(BASE_INPUTS.latestCommit);
    if (argv[0] === "pr" && argv[1] === "diff") return "diff";
    return "[]";
  };
  const code = await cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-1100", "--repo", "aiosbrain/aios-devtools", "--local-bugbot-review", review], {
    runGh, readReviewerPrompt: () => "review", callAgent: async () => "## Verdict\n\nCLEAR\n\nBUGBOT_CLEAR\n", now: () => { throw new Error("must stay unused"); },
  });
  assert.equal(code, 0);
});
