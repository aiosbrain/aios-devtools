import test from "node:test";
import assert from "node:assert/strict";
import { buildCodeReviewPrompt } from "../scripts/review-prompt.mjs";
import { buildCodeReviewPrompt as viaBuild } from "../scripts/build.mjs";
import { promptCallHasTools } from "../scripts/model-call.mjs";

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
  assert.match(p, /evidence-based findings/);
});

test("toolless prompt names the verification that ran, or says none did", () => {
  const ran = buildCodeReviewPrompt({ ...base, toolless: true, verifyCmd: "npm test" });
  assert.match(ran, /already ran `npm test`/);
  const none = buildCodeReviewPrompt({ ...base, toolless: true, verifyCmd: null });
  assert.match(none, /No verification command was configured/);
  assert.doesNotMatch(none, /already ran/);
});

test("only cursor and codex review calls have tools", () => {
  for (const m of ["cursor:gpt-5.5", "codex:gpt-5.6-sol"]) assert.equal(promptCallHasTools(m), true, m);
  for (const m of ["deepseek-v4-pro", "deepseek:deepseek-v4-pro", "openrouter:deepseek/deepseek-chat", "opencode:glm-5.2", "claude:fable-5", "zai:glm-5"]) {
    assert.equal(promptCallHasTools(m), false, m);
  }
});

test("build.mjs still re-exports buildCodeReviewPrompt", () => {
  assert.equal(viaBuild, buildCodeReviewPrompt);
});
