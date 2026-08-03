// test/bugbot-model-pin.test.mjs — the mandatory local Bugbot reviewer model cannot be forged.
//
// AIO-662 (split out of aios-workspace's test/local-bugbot-gate.test.mjs): the gate's own
// behaviour, and the fact that the CHILD reviewer is invoked with the required model, stay in
// core. What moves here are the assertions about the DEVTOOLS callers — `ship.mjs` and
// `build.mjs` — namely that neither can be steered onto a forged reviewer model: there is no
// `AIOS_BUGBOT_MODEL` env escape hatch, and both pin `REQUIRED_BUGBOT_MODEL`. That is a
// security property of the review gate: if a repo could set `AIOS_BUGBOT_MODEL` and have
// devtools honour it, "reviewed by the required model" would be worth nothing.
//
// The core file it came from warns: assert BEHAVIOUR, never source text (source-text matching
// breaks under the mutation lane, which rewrites the very literals a regex looks for). So:
//   - ship.mjs IS asserted behaviourally — runShip is driven end-to-end with a forged
//     AIOS_BUGBOT_MODEL in the environment and the model that actually reaches the review
//     engine is compared against REQUIRED_BUGBOT_MODEL read from the seam.
//   - build.mjs falls back to source text, deliberately and narrowly. Its pin executes inside
//     the module-private `finish()` (cmdBuild's merge/PR gate), which is only reachable
//     through a real worktree + git + gh; there is no injectable entry point for it today.
//     The regex is the honest available proof, and it is marked as such.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runShip, SHIP_EXIT } from "../scripts/ship.mjs";
import { EXIT as BUILD_EXIT } from "../scripts/build.mjs";
import { resolveLoopModels } from "../scripts/loop-models.mjs";
import { loadToolkitModule } from "../scripts/toolkit-locate.mjs";
import { stubSpecRubric } from "./ship-test-helpers.mjs";
import { toolkitDir, toolkitSkip } from "./fixture-workspace.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEAM_SKIP = toolkitDir() ? false : toolkitSkip("the stays-core review engine");

const PLAN_TEXT = "# Plan\n1. do the thing\n";
const greenChecks = JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]);

function makeIssue() {
  return {
    identifier: "AIO-163",
    title: "Add ship command",
    description: "Build the thing.",
    state: { name: "Todo", type: "unstarted" },
    children: [],
    comments: [],
    blockedBy: [],
  };
}

function makeDeps({ repo, reviewCalls }) {
  return {
    repo,
    linear: {
      getIssue: async () => makeIssue(),
      createIssue: async () => ({ identifier: "AIO-901" }),
      addComment: async () => ({ ok: true }),
    },
    resolveModels: resolveLoopModels,
    resolveBugbotBase: () => ({ ok: true, baseSha: "test-base" }),
    // The assertion subject: whatever model ship actually hands the review engine.
    runLocalPrePrReview: async (opts = {}) => {
      reviewCalls.push(opts.model);
      return { ok: true, output: "BUGBOT_CLEAR" };
    },
    runBuild: async () => BUILD_EXIT.OK,
    cmdPr: async () => 77,
    cmdConsolidateFindings: async () => 0, // CLEAR
    callClaudeAgent: async (prompt) => {
      if (/recon context pack/.test(prompt)) return "RECON CONTEXT";
      if (/implementation plan/.test(prompt)) return PLAN_TEXT;
      if (/safety reviewer/.test(prompt)) return "reviewed\nSAFETY_APPROVED";
      return "generic";
    },
    callCursorAgent: async (prompt) =>
      prompt.includes("/review-plan") ? "looks good\nPLAN_READY" : "- `Low` `f`: nit",
    callDeepSeekDirect: async (prompt) =>
      prompt.includes("/review-plan") ? "looks good\nPLAN_READY" : "- `Low` `f`: nit",
    waitForBots: () => 0,
    gitExec: (argv) => (argv[0] === "rev-parse" ? "fakehead\n" : ""),
    ghExec: (argv) => {
      const a = argv.join(" ");
      if (a.includes("headRefOid")) return { code: 0, stdout: "fakehead\n", stderr: "" };
      if (a.includes("pr checks")) return { code: 0, stdout: greenChecks, stderr: "" };
      if (a.includes("--name-only")) return { code: 0, stdout: "scripts/aios.mjs", stderr: "" };
      if (a.includes("pr diff")) return { code: 0, stdout: "diff --git a b", stderr: "" };
      if (a.includes("pr merge")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    gitLsFiles: () => new Set(["docs/brain-api.md", "scripts/aios.mjs"]),
    statFile: () => ({ size: 100 }),
    readFile: () => "file contents",
    confirm: async () => true,
    isTty: true,
    writeAudit: (issue, name, text) => {
      const dir = path.join(repo, ".aios", "loop", issue);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, name), String(text));
    },
    slug: "acme/repo",
    evaluateSpec: async () => ({
      verdict: "SPEC_READY",
      exitCode: 0,
      score: 100,
      deterministic: [],
      adversarial: { findings: [] },
      findings: [],
    }),
    loadRecentDecisions: async () => [],
    loadSpecRubric: () => stubSpecRubric(),
    makeAnthropic: async () => ({ fake: true }),
  };
}

test(
  "ship pins the required Bugbot model — a forged AIOS_BUGBOT_MODEL is ignored (behavioural)",
  { skip: SEAM_SKIP },
  async () => {
    const { REQUIRED_BUGBOT_MODEL } = await loadToolkitModule("review-bugbot.mjs");
    const repo = mkdtempSync(path.join(tmpdir(), "bugbot-model-pin-"));
    const reviewCalls = [];
    const previous = process.env.AIOS_BUGBOT_MODEL;
    process.env.AIOS_BUGBOT_MODEL = "cursor:forged-reviewer";
    try {
      const { code } = await runShip({
        repo,
        issue: "AIO-163",
        opts: {
          auto: true,
          autoMerge: true,
          maxFixRounds: 3,
          reviewers: ["bugbot", "gpt-5.5"],
          planRunner: "cli",
          dryRun: false,
        },
        deps: makeDeps({ repo, reviewCalls }),
      });
      assert.equal(code, SHIP_EXIT.OK, "run completes OK");
      assert.ok(reviewCalls.length >= 1, "the local Bugbot review actually ran");
      for (const model of reviewCalls) {
        assert.equal(
          model,
          REQUIRED_BUGBOT_MODEL,
          "every local review must use the required model, never the env override"
        );
        assert.notEqual(model, "cursor:forged-reviewer");
      }
    } finally {
      if (previous === undefined) delete process.env.AIOS_BUGBOT_MODEL;
      else process.env.AIOS_BUGBOT_MODEL = previous;
      rmSync(repo, { recursive: true, force: true });
    }
  }
);

test("build has no AIOS_BUGBOT_MODEL escape hatch and pins the required model (source text)", () => {
  // Source-text, knowingly: the pin lives in build.mjs's module-private `finish()` — the
  // merge/PR gate — which has no injectable entry point, so there is nothing to drive
  // behaviourally without a real worktree, git and gh. If `finish()` (or the gate) ever gains
  // a testable seam, replace this with the behavioural form used for ship above.
  const build = readFileSync(path.join(REPO_ROOT, "scripts", "build.mjs"), "utf8");
  assert.doesNotMatch(
    build,
    /AIOS_BUGBOT_MODEL/,
    "build must not honour an AIOS_BUGBOT_MODEL env override"
  );
  assert.match(
    build,
    /model:\s*(?:\w+\.)?REQUIRED_BUGBOT_MODEL/,
    "build must pass the required Bugbot model (seam-qualified since AIO-594)"
  );
});

test("ship pins the required model at its single assignment site (source text)", () => {
  // The behavioural test above is the primary proof; this keeps the original core assertion
  // so an accidental re-introduction of a configurable reviewer model is caught at review time
  // even on the no-toolkit lane where the behavioural test skips.
  const ship = readFileSync(path.join(REPO_ROOT, "scripts", "ship.mjs"), "utf8");
  assert.match(ship, /const reviewModel = REQUIRED_BUGBOT_MODEL/);
  assert.doesNotMatch(ship, /AIOS_BUGBOT_MODEL/);
});
