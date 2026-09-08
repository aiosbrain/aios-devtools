import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cmdConsolidateFindings } from "../scripts/consolidate-findings.mjs";

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
