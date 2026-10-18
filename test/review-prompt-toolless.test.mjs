import test from "node:test";
import assert from "node:assert/strict";
import { buildCodeReviewPrompt } from "../scripts/review-prompt.mjs";
import { buildCodeReviewPrompt as viaBuild } from "../scripts/build.mjs";

const base = {
  skill: "/ai-code-review",
  plan: "plan",
  diff: "diff",
  diffStat: "stat",
  logOneline: "abc fix",
  secretsResult: "clean",
  branch: "feat/x",
  round: 1,
  maxRounds: 4,
};

test("tool-capable reviewer is told to run the tests itself", () => {
  const p = buildCodeReviewPrompt(base);
  assert.match(p, /Run the project's tests\/validators yourself/);
  assert.doesNotMatch(p, /NO tools/);
});

test("prompt-only reviewer is told it has no tools and must not emit tool calls", () => {
  const p = buildCodeReviewPrompt({ ...base, toolless: true });
  assert.match(p, /NO tools in this session/);
  assert.match(p, /never emit tool calls/);
  assert.doesNotMatch(p, /Run the project's tests\/validators yourself/);
  assert.match(p, /MERGE_READY/);
});

test("build.mjs still re-exports buildCodeReviewPrompt", () => {
  assert.equal(viaBuild, buildCodeReviewPrompt);
});
