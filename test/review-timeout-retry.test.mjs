// test/review-timeout-retry.test.mjs — pure exports from build.mjs for review resilience:
// isTimeoutError, reviewWithTimeoutRetry (retry-once-on-timeout with a doubled timeout),
// adaptiveReviewTimeout boundaries, and computeReviewPayloadChars (the pre-truncation,
// DIFF_CAP-clamped size the timeout keys off — Major 3). Injected fake agent; no live cursor.
//
// AIO-662 (moved from aios-workspace): every unit here is build.mjs's own review resilience,
// which is devtools. The final block asserts the LOCAL BUGBOT WALL-CLOCK BUDGET, whose
// constants live in the stays-core review-bugbot.mjs — loaded through the toolkit seam
// (docs/devtools-toolkit-contract.md), so it skips with a named reason without a toolkit.

import test from "node:test";
import assert from "node:assert/strict";
import {
  isTimeoutError,
  reviewWithTimeoutRetry,
  adaptiveReviewTimeout,
  computeReviewPayloadChars,
  DIFF_CAP,
} from "../scripts/build.mjs";
import { loadToolkitModule } from "../scripts/toolkit-locate.mjs";
import { toolkitDir, toolkitSkip } from "./fixture-workspace.mjs";

// Silence the retry's console.log during runs.
async function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

const timeoutErr = () =>
  new Error("cursor agent timed out after 300s — increase the timeout and retry");
const exitErr = () => new Error("cursor agent exited 1: boom");

test("isTimeoutError", () => {
  assert.equal(isTimeoutError(timeoutErr()), true, "true for timeout shape");
  assert.equal(isTimeoutError(exitErr()), false, "false for exit shape");
  assert.equal(isTimeoutError(undefined), false, "false for undefined");
});

test("reviewWithTimeoutRetry — one timeout then success", async () => {
  const calls = [];
  let n = 0;
  const callFn = async (p, t, o) => {
    calls.push({ t, o });
    n++;
    if (n === 1) throw timeoutErr();
    return "REVIEW OK";
  };
  const logs = [];
  const rv = await quiet(() =>
    reviewWithTimeoutRetry(
      callFn,
      "prompt",
      300000,
      { cwd: "/wt" },
      { log: (l, m) => logs.push(`${l}: ${m}`) }
    )
  );
  assert.equal(rv, "REVIEW OK", "returns the second-attempt result");
  assert.equal(calls.length, 2, "retried exactly twice");
  assert.equal(calls[1].t, 600000, "second attempt uses 2× timeout");
  assert.equal(calls[1].o.cwd, "/wt", "opts are forwarded");
  assert.ok(
    logs.some((l) => /300s/.test(l) && /600s/.test(l) && /attempt 2\/2/.test(l)),
    "logs the retry decision (original/doubled/attempt)"
  );
});

test("reviewWithTimeoutRetry — second timeout propagates", async () => {
  let n = 0;
  const callFn = async () => {
    n++;
    throw timeoutErr();
  };
  let threw = false;
  await quiet(async () => {
    try {
      await reviewWithTimeoutRetry(callFn, "p", 100000, {});
    } catch {
      threw = true;
    }
  });
  assert.equal(threw, true, "rejects after a second timeout");
  assert.equal(n, 2, "exactly 2 invocations");
});

test("reviewWithTimeoutRetry — non-timeout error is NOT retried", async () => {
  let n = 0;
  const callFn = async () => {
    n++;
    throw exitErr();
  };
  let threw = false;
  await quiet(async () => {
    try {
      await reviewWithTimeoutRetry(callFn, "p", 100000, {});
    } catch {
      threw = true;
    }
  });
  assert.equal(threw, true, "rejects immediately");
  assert.equal(n, 1, "exactly 1 invocation (no retry)");
});

test("adaptiveReviewTimeout boundaries (seconds)", () => {
  assert.equal(adaptiveReviewTimeout(0), 300, "0 chars → 300");
  assert.equal(adaptiveReviewTimeout(10000), 360, "10000 → 360");
  assert.equal(adaptiveReviewTimeout(49999), 540, "49999 → 540");
  assert.equal(adaptiveReviewTimeout(50000), 600, "50000 (=DIFF_CAP) → 600");
  assert.equal(adaptiveReviewTimeout(999999), 600, ">50000 → 600 (cap)");
  assert.equal(
    adaptiveReviewTimeout(30000, { base: 120, cap: 200 }),
    200,
    "custom base/cap honored"
  );
  assert.equal(adaptiveReviewTimeout(null), 300, "null payload → base");
});

test("computeReviewPayloadChars (Major 3) — clamped to DIFF_CAP", () => {
  assert.equal(computeReviewPayloadChars("abcde"), 5, "small diff → own length");
  const big = "x".repeat(DIFF_CAP + 20000);
  assert.equal(computeReviewPayloadChars(big), DIFF_CAP, "over-cap diff → clamped to DIFF_CAP");
  // The whole point of Major 3: an over-cap diff scales the timeout to the 2× cap (600s),
  // NOT to the tiny truncation-message length it would otherwise collapse to.
  assert.equal(
    adaptiveReviewTimeout(computeReviewPayloadChars(big)) * 1000,
    600000,
    "over-cap payload → timeout at the 600s cap"
  );
  assert.equal(computeReviewPayloadChars(null), 0, "null → 0");
});

test(
  "local Bugbot wall-clock budget replaces the derived retry budget",
  { skip: toolkitDir() ? false : toolkitSkip("review-bugbot.mjs wall-clock budget constants") },
  async () => {
    // The old `cursorReviewRetryBudgetMs(timeout)` = attempts × 3 × timeout + backoff was the
    // bug: adding the AIO-468 protocol re-ask silently doubled the real worst case (~4,804s)
    // while the parent hook still sized its child kill from the old number (~2,422s), so the
    // hook SIGTERMed its own child mid-review. One absolute budget cannot drift that way.
    const reviewBugbot = await loadToolkitModule("review-bugbot.mjs");
    assert.equal(
      reviewBugbot.cursorReviewRetryBudgetMs,
      undefined,
      "the multiplicative retry budget export is gone"
    );
    const { REVIEW_WALL_CLOCK_BUDGET_MS, MIN_ATTEMPT_MS, ATTEMPT_RESERVE_MARGIN_MS } = reviewBugbot;
    const hookChildTimeoutSeconds = 400; // hooks/local-bugbot-gate.mjs
    const reserveMs = hookChildTimeoutSeconds * 1000 + ATTEMPT_RESERVE_MARGIN_MS;
    assert.ok(
      hookChildTimeoutSeconds * 1000 <= REVIEW_WALL_CLOCK_BUDGET_MS - reserveMs,
      "a full first attempt fits inside the code pass's allowance (never truncated)"
    );
    assert.ok(
      reserveMs > hookChildTimeoutSeconds * 1000,
      "the security reservation covers a FULL attempt, not just a start"
    );
    assert.ok(
      REVIEW_WALL_CLOCK_BUDGET_MS < 2 * (2 * 3 * hookChildTimeoutSeconds * 1000),
      "the worst case is the budget, not attempts × passes × timeout"
    );
    assert.ok(
      REVIEW_WALL_CLOCK_BUDGET_MS >= 2 * hookChildTimeoutSeconds * 1000,
      "both mandatory passes can each take a full attempt"
    );
    assert.equal(MIN_ATTEMPT_MS, 180_000, "the protocol re-ask floor is still a meaningful attempt");
  }
);
