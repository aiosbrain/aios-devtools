// test/cli-output-contract.test.mjs — the DEVTOOLS half of aios-workspace's
// test/cli-output-contract.test.mjs (AIO-662 split), i.e. the executable half of
// docs/cli-output-contract.md for the machine-readable lines this repo owns.
//
// Two directions, and conflating them is the easy mistake:
//   Class E — EMITTED by AIOS for an external consumer (a hook, CI, an operator's grep).
//   Class D — DETECTED by AIOS from a subprocess/reviewer model's captured output.
// Detectors are exercised through their REAL exported implementations, so this file cannot
// drift into testing a copy of the rule.
//
// What stayed in core: the Bugbot + simplify markers and detectors (review-bugbot.mjs,
// simplify.mjs) and the leak gate. What is here is the devtools-owned surface:
//   - `cmdConsolidateFindings` (consolidate-findings.mjs) and its final stdout verdict line
//   - `detectMergeToken` (build.mjs)
//   - `SAFETY_APPROVED_TOKEN` + `detectSafetyToken` (ship.mjs)
//
// AIO-684: the marker literals are now SPLIT across repos — `MERGE_READY_TOKEN` is defined
// in relay-core.mjs (core; carried here as copy-ledger item #1) while its detector lives in
// build.mjs, and `SAFETY_APPROVED_TOKEN` is defined in ship.mjs. So the "no token is a
// prefix of another" guarantee cannot be checked in full from EITHER repo alone: core covers
// the Bugbot/simplify/plan set, this file covers the devtools set. The likely fix is moving
// the literals into @aiosbrain/foundation; until then both halves are partial by construction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// MERGE_READY_TOKEN's definition site is core's scripts/relay-core.mjs; this repo carries a
// temporary copy (docs/copy-ledger.md #1), which is what build.mjs itself imports. It is NOT
// a seam module (the seam covers review-bugbot/simplify/relay/spec-author), so importing the
// local copy is correct here — the detector and the literal it detects must be the same pair.
import { MERGE_READY_TOKEN, PLAN_READY_TOKEN } from "../scripts/relay-core.mjs";
import { detectMergeToken } from "../scripts/build.mjs";
import { SAFETY_APPROVED_TOKEN, detectSafetyToken } from "../scripts/ship.mjs";
import { cmdConsolidateFindings } from "../scripts/consolidate-findings.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUGBOT_CLEAR_TOKEN = "BUGBOT_CLEAR"; // core-defined (review-bugbot.mjs); only used as
// input bytes for the consolidator fixture below, never as the assertion subject.

// ── Class E: the emitted verdict line ───────────────────────────────────────

test("E: the real consolidator emits a final stdout verdict and returns its documented code", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-contract-consolidate-"));
  const localReview = path.join(dir, "local-bugbot.md");
  const out = path.join(dir, "findings.md");
  writeFileSync(localReview, `${BUGBOT_CLEAR_TOKEN}\n`);
  const logs = [];
  const originalLog = console.log;

  try {
    console.log = (line = "") => logs.push(String(line));
    const runGh = (args) => {
      if (args[0] === "pr" && args[1] === "checks") {
        return {
          code: 0,
          stdout: JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]),
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "diff") return "diff --git a/x b/x\n+ok\n";
      if (args[0] === "api" && args[1].endsWith("/commits")) {
        return JSON.stringify({ sha: "head123", committed_at: "2026-07-27T00:00:00Z" });
      }
      if (args[0] === "api") return "[]";
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };
    const clearOutput = readFileSync(
      path.join(REPO, "test", "fixtures", "consolidate", "agent-clear.md"),
      "utf8"
    );
    const blockedOutput = readFileSync(
      path.join(REPO, "test", "fixtures", "consolidate", "agent-blocked.md"),
      "utf8"
    );
    const args = [
      "--pr",
      "423",
      "--issue",
      "AIO-423",
      "--repo",
      "acme/repo",
      "--local-bugbot-review",
      localReview,
      "--out",
      out,
    ];
    const deps = (modelOutput) => ({
      runGh,
      readReviewerPrompt: () => "Return a structured verdict.",
      callPromptModel: async () => modelOutput,
    });
    const code = await cmdConsolidateFindings(REPO, args, deps(clearOutput));

    assert.equal(code, 0);
    assert.equal(logs.at(-1), "VERDICT=CLEAR", "verdict must be the final stdout line");
    assert.ok(!logs.at(-1).includes("["), "verdict must not be styled");

    logs.length = 0;
    const blockedCode = await cmdConsolidateFindings(REPO, args, deps(blockedOutput));
    assert.equal(blockedCode, 3);
    assert.equal(logs.at(-1), "VERDICT=BLOCKED", "blocked verdict must be final on stdout");
    assert.ok(!logs.at(-1).includes("["), "blocked verdict must not be styled");
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Class D: the detection dialect, via the real detectors ──────────────────

// Class-D detectors intentionally use different dialects. These cases pin each dialect
// against the shipped implementation instead of testing a copied, over-generalised rule.

const REVIEW_PREAMBLE = "I reviewed the diff.\n\nLooks fine to me.\n";

test("D: detectMergeToken accepts the token on the last non-blank line", () => {
  assert.equal(detectMergeToken(`${REVIEW_PREAMBLE}${MERGE_READY_TOKEN}`), true);
  assert.equal(detectMergeToken(`${MERGE_READY_TOKEN}\n\n  \n`), true, "trailing blanks ok");
  assert.equal(detectMergeToken(`  ${MERGE_READY_TOKEN}  `), true, "surrounding space ok");
});

test("D: detectMergeToken tolerates glued trailing prose but requires a word boundary", () => {
  assert.equal(detectMergeToken(`${MERGE_READY_TOKEN} - lgtm`), true, "streaming artifact");
  assert.equal(detectMergeToken(`${MERGE_READY_TOKEN}_SOMETHING_ELSE`), false, "no boundary");
});

test("D: detectMergeToken rejects the token anywhere but the last line", () => {
  // This is the whole hazard: anything appended AFTER the verdict destroys it.
  assert.equal(
    detectMergeToken(`${MERGE_READY_TOKEN}\nnow running cleanup...`),
    false,
    "a line appended after the verdict must break detection"
  );
  assert.equal(detectMergeToken(`${MERGE_READY_TOKEN}\n✓ done in 4.2s`), false);
});

test("D: detectSafetyToken requires STRICT equality — the most fragile detector", () => {
  assert.equal(detectSafetyToken(`${REVIEW_PREAMBLE}${SAFETY_APPROVED_TOKEN}`), true);
  assert.equal(detectSafetyToken(`  ${SAFETY_APPROVED_TOKEN}  `), true, "trim only");

  // Unlike detectMergeToken, NOTHING may be glued on. A single trailing character —
  // a space-separated word, a glyph, a reset sequence — turns approval into refusal.
  assert.equal(detectSafetyToken(`${SAFETY_APPROVED_TOKEN} - looks good`), false);
  assert.equal(detectSafetyToken(`${SAFETY_APPROVED_TOKEN}.`), false);
  assert.equal(detectSafetyToken(`${SAFETY_APPROVED_TOKEN}\x1b[0m`), false, "a reset breaks it");
  assert.equal(detectSafetyToken(null), false);
});

test("D: decoration in a captured verdict stream breaks each devtools detector", () => {
  // Placement depends on the detector: after the token for these two last-line/strict dialects.
  const decoration = "\n      ▞  review      done · 4.2s";
  assert.equal(detectMergeToken(`${MERGE_READY_TOKEN}${decoration}`), false);
  assert.equal(detectSafetyToken(`${SAFETY_APPROVED_TOKEN}${decoration}`), false);
});

test("D: an ANSI-wrapped token is NOT detected — markers must be written raw", () => {
  // Proves markers cannot be routed through a colour helper.
  const wrap = (s) => `\x1b[0;32m${s}\x1b[0m`;
  assert.equal(detectMergeToken(wrap(MERGE_READY_TOKEN)), false);
  assert.equal(detectSafetyToken(wrap(SAFETY_APPROVED_TOKEN)), false);
});

// ── token literals ──────────────────────────────────────────────────────────

test("devtools token literals match the contract document", () => {
  assert.equal(SAFETY_APPROVED_TOKEN, "SAFETY_APPROVED");
  // Pinned here too because build.mjs's detector is built from this literal — if the local
  // relay-core copy drifts from core's, the detector silently stops matching real reviews.
  assert.equal(MERGE_READY_TOKEN, "MERGE_READY");
});

test("no devtools-reachable Class-D token is a prefix of another", () => {
  // Partial by construction — see the AIO-684 note in this file's header. Core owns the
  // complementary half (Bugbot + simplify tokens).
  const tokens = [MERGE_READY_TOKEN, PLAN_READY_TOKEN, SAFETY_APPROVED_TOKEN];
  for (const a of tokens) {
    for (const b of tokens) {
      if (a === b) continue;
      assert.ok(!a.startsWith(b), `${a} must not start with ${b}`);
    }
  }
});
