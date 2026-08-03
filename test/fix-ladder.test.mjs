// test/fix-ladder.test.mjs — the pure fix-escalation ladder (selectBuilderStep, build.mjs) and
// the shared structural Critical/High matcher (hasCriticalOrHighFindings), plus a regression
// that detectBugbotClear is unchanged after the matcher extraction.
//
// AIO-662 (moved from aios-workspace): selectBuilderStep is devtools' build ladder, so the test
// belongs here. Two source splits follow docs/devtools-toolkit-contract.md:
//   - hasCriticalOrHighFindings comes from the core LEAF scripts/severity.mjs, which the contract
//     deliberately keeps OUT of the seam (already in the declared copy set);
//   - detectBugbotClear lives in the stays-core review-bugbot.mjs, reachable only through
//     loadToolkitModule() — so that block skips with a named reason without a toolkit checkout.
//
// KEY INVARIANT: the ladder keys on hasPriorFeedback + a fixAttempt counter, NEVER the
// outer loop round, and NEVER detectBugbotClear. Round 1 (no feedback) → "build".

import test from "node:test";
import assert from "node:assert/strict";
import { selectBuilderStep } from "../scripts/build.mjs";
import { hasCriticalOrHighFindings } from "../scripts/severity.mjs";
import { loadToolkitModule } from "../scripts/toolkit-locate.mjs";
import { toolkitDir, toolkitSkip } from "./fixture-workspace.mjs";

const MEDIUM_ONLY = "## Findings\n\n- Medium: tidy this up.\n\nNot ready to merge.";
const CRIT_BULLET = "## Findings\n\n- Critical: unsafe eval on user input.\n";
const HIGH_ROW = "## Findings\n\n| Severity | Note |\n| High | missing auth check |\n";

test("selectBuilderStep — no prior feedback → build (round 1 initial impl)", () => {
  assert.equal(
    selectBuilderStep({ hasPriorFeedback: false, fixAttempt: 0, reviewText: null }),
    "build"
  );
});

test("selectBuilderStep — first fix attempt, Medium-only → fix", () => {
  assert.equal(
    selectBuilderStep({ hasPriorFeedback: true, fixAttempt: 1, reviewText: MEDIUM_ONLY }),
    "fix"
  );
});

test("selectBuilderStep — first fix attempt with a Critical bullet → fix_escalated", () => {
  assert.equal(
    selectBuilderStep({ hasPriorFeedback: true, fixAttempt: 1, reviewText: CRIT_BULLET }),
    "fix_escalated"
  );
});

test("selectBuilderStep — first fix attempt with a High table row → fix_escalated", () => {
  assert.equal(
    selectBuilderStep({ hasPriorFeedback: true, fixAttempt: 1, reviewText: HIGH_ROW }),
    "fix_escalated"
  );
});

test("selectBuilderStep — second fix attempt, Medium-only → fix_escalated", () => {
  assert.equal(
    selectBuilderStep({ hasPriorFeedback: true, fixAttempt: 2, reviewText: MEDIUM_ONLY }),
    "fix_escalated"
  );
});

test("hasCriticalOrHighFindings (structural)", () => {
  assert.equal(hasCriticalOrHighFindings(MEDIUM_ONLY), false, "Medium-only body → false");
  assert.equal(hasCriticalOrHighFindings(CRIT_BULLET), true, "`- Critical:` bullet → true");
  assert.equal(hasCriticalOrHighFindings(HIGH_ROW), true, "`| High |` table row → true");
  assert.equal(
    hasCriticalOrHighFindings("There are no Critical or High findings here."),
    false,
    "prose 'no Critical or High findings' → false"
  );
  assert.equal(hasCriticalOrHighFindings(null), false, "empty/null → false");
});

test(
  "detectBugbotClear regression (unchanged after extraction)",
  { skip: toolkitDir() ? false : toolkitSkip("review-bugbot.mjs (detectBugbotClear)") },
  async () => {
    const { detectBugbotClear } = await loadToolkitModule("review-bugbot.mjs");
    assert.equal(detectBugbotClear("BUGBOT_CLEAR"), true, "exact BUGBOT_CLEAR clears");
    assert.equal(
      detectBugbotClear("## Findings\n\n- Critical: bad\n"),
      false,
      "Critical bullet with no trailing token blocks"
    );
    assert.equal(
      detectBugbotClear("- Critical: bad\n\nBUGBOT_CLEAR"),
      false,
      "trailing token cannot override a Critical bullet"
    );
    assert.equal(
      detectBugbotClear("No Critical issues found.\n\nBUGBOT_CLEAR"),
      false,
      "even no-findings prose makes the protocol non-clear"
    );
  }
);
