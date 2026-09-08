import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cmdConsolidateFindings } from "../scripts/consolidate-findings.mjs";
import { acquireAtomicJsonlLease, releaseAtomicJsonlLease } from "../scripts/atomic-jsonl.mjs";
import { loadFindingRegistry, normalizeFindingInventory } from "../scripts/finding-observations.mjs";

test("CI candidate identities follow checks across source reordering", () => {
  const checks = [{ name: "unit tests", state: "FAILURE", bucket: "fail", conclusion: "" },
    { name: "integration tests", state: "CANCELLED", bucket: "cancel", conclusion: "" }];
  const options = { repoSlug: "aiosbrain/aios-devtools", issue: "AIO-1100", pr: 44, round: 1,
    observedAt: "2026-09-08T00:00:00Z", registry: loadFindingRegistry() };
  const make = (ordered) => normalizeFindingInventory({ localBugbotMarkdown: "BUGBOT_CLEAR", checks: { checks: ordered },
    latestCommit: { sha: "a".repeat(40), committed_at: options.observedAt } }, options);
  const keyed = (inventory, ordered) => Object.fromEntries(inventory.candidates.map((candidate) =>
    [ordered[candidate.source_locator.item].name, candidate.source_key]));
  assert.deepEqual(keyed(make(checks), checks), keyed(make([...checks].reverse()), [...checks].reverse()));
  for (const name of ["deploy synthetic.person@example.invalid", "build (/Users/synthetic/project)", "build:/home/synthetic/project"]) {
    const unsafe = make([{ name, state: "FAILURE", bucket: "fail", conclusion: "" }]);
    assert.equal(unsafe.candidates.length, 0); assert.equal(unsafe.malformed, 1);
  }
  assert.equal(make([null]).malformed, 1);
});

test("CodeRabbit paths disambiguate otherwise identical structural records", () => {
  const options = { repoSlug: "aiosbrain/aios-devtools", issue: "AIO-1100", pr: 44, round: 1,
    observedAt: "2026-09-08T00:00:00Z", registry: loadFindingRegistry() };
  const inputs = { localBugbotMarkdown: "BUGBOT_CLEAR", checks: { checks: [] }, inlineComments: [
    { path: "src/a.mjs", line: 10, body: "**Major:** finding" },
    { path: "src/b.mjs", line: 10, body: "**Major:** finding" }] };
  const forward = normalizeFindingInventory(inputs, options);
  const reverse = normalizeFindingInventory({ ...inputs, inlineComments: [...inputs.inlineComments].reverse() }, options);
  assert.equal(new Set(forward.candidates.map((candidate) => candidate.source_key)).size, 2);
  assert.deepEqual(forward.candidates.map((candidate) => candidate.source_key), reverse.candidates.map((candidate) => candidate.source_key));
});

test("relative repo default report path collides with the absolute observation path", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "finding-relative-")); const previous = process.cwd();
  const review = path.join(repo, "review.md"); writeFileSync(review, "BUGBOT_CLEAR\n"); process.chdir(repo);
  try {
    const output = path.resolve(".aios/loop/AIO-1100/findings-r1.md"); let called = false;
    const code = await cmdConsolidateFindings(".", ["--pr", "44", "--issue", "AIO-1100", "--repo", "aiosbrain/aios-devtools",
      "--local-bugbot-review", review, "--finding-observations", output], { callAgent: async () => { called = true; } });
    assert.equal(code, 1); assert.equal(called, false);
  } finally { process.chdir(previous); }
});

test("a stale recovery guard is claimed without replacing a newer owner", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "finding-stale-"));
  const out = path.join(repo, "observations.jsonl"); const lock = `${out}.lease`;
  const old = Date.now() - 16 * 60 * 1000;
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, created_at_ms: old, nonce: "old" }));
  writeFileSync(`${lock}.recovery-old`, JSON.stringify({ pid: 2147483647, created_at_ms: old, nonce: "guard" }));
  utimesSync(lock, new Date(old), new Date(old)); utimesSync(`${lock}.recovery-old`, new Date(old), new Date(old));
  const lease = acquireAtomicJsonlLease(out);
  assert.throws(() => acquireAtomicJsonlLease(out), /locked/);
  releaseAtomicJsonlLease(lease);
});

test("one consolidation owns the observation output through provider completion", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "finding-lease-"));
  const review = path.join(repo, "bugbot.md"); const out = path.join(repo, "observations.jsonl");
  writeFileSync(review, "- High: captured finding\n");
  const args = ["--pr", "44", "--issue", "AIO-1100", "--repo", "aiosbrain/aios-devtools", "--local-bugbot-review", review, "--finding-observations", out];
  const runGh = (argv) => {
    if (argv[0] === "pr" && argv[1] === "checks") return { code: 0, stdout: "[]", stderr: "" };
    if (argv[0] === "api" && argv[1].endsWith("/commits")) return JSON.stringify({ sha: "a".repeat(40), committed_at: "2026-09-08T00:00:00Z" });
    if (argv[0] === "pr" && argv[1] === "diff") return "diff";
    return "[]";
  };
  let releaseProvider; const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const first = cmdConsolidateFindings(repo, args, {
    runGh, readReviewerPrompt: () => "review", now: () => "2026-09-08T00:00:00Z",
    callAgent: async () => { await providerGate; throw new Error("provider down"); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  let secondModelCalled = false;
  const second = await cmdConsolidateFindings(repo, args, {
    runGh, readReviewerPrompt: () => "review", now: () => "2026-09-08T00:00:00Z",
    callAgent: async () => { secondModelCalled = true; },
  });
  assert.equal(second, 1); assert.equal(secondModelCalled, false);
  releaseProvider(); assert.equal(await first, 1);
  const records = readFileSync(out, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records.at(-1).capture_status, "partial");
});
