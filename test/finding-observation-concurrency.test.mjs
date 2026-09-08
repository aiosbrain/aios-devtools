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
