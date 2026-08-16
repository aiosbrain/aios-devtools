// Unit tests for routeSkillPrompt's explicit-sigil boundary rule (AIO-663 copy-ledger row 6).
//
// `scripts/skill-context.mjs` is a temporary copy shared with `aiosbrain/aios-workspace`, and this
// repo's copy carried a naive `(?:\$|/)<id>(?:\b|$)` matcher long after core hardened it: with no
// leading-boundary assertion, ANY `/id` substring routed — a URL path segment, a filesystem path,
// or a token glued to the preceding word. Since spec-publish/ship route on this, a prompt that
// merely *cited* a doc URL could silently invoke a skill. The suite is built by hand rather than
// loaded from a toolkit checkout so this runs in the no-toolkit lane too.
import test from "node:test";
import assert from "node:assert/strict";

import { routeSkillPrompt } from "../scripts/skill-context.mjs";

function skill(id, overrides = {}) {
  return {
    id,
    path: `${id}/SKILL.md`,
    stages: ["builder", "interactive"],
    routing: { positive: [`use ${id}`], negative: [] },
    mutability: "local-write",
    max_bytes: 6000,
    bytes: 10,
    conflicts: [],
    prerequisites: [],
    explicit_invocation_required: false,
    ...overrides,
  };
}

const suite = {
  skills: [skill("linear-publish-spec"), skill("linear-publish-spec-typo")],
  limits: { builder_skill_count: 4, builder_total_bytes: 6000, stage_skill_bytes: 6000 },
};

test("a sigil at a real token boundary routes explicitly", () => {
  for (const prompt of [
    "Use $linear-publish-spec for AIO-1.",
    "Use /linear-publish-spec for AIO-1.",
    "$linear-publish-spec",
    "Please (use $linear-publish-spec).",
    "Try `/linear-publish-spec`.",
  ]) {
    assert.equal(routeSkillPrompt({ suite, prompt })?.id, "linear-publish-spec", prompt);
  }
});

test("URL, filesystem-path, and embedded-token substrings never route", () => {
  for (const prompt of [
    "See https://example.test/linear-publish-spec",
    "Read docs/linear-publish-spec/SKILL.md",
    "Ignore prefix$linear-publish-spec",
    "Ignore prefix/linear-publish-spec",
    "Use /linear-publish-spec/SKILL.md",
  ]) {
    assert.equal(routeSkillPrompt({ suite, prompt }), null, prompt);
  }
});

test("a longer id is not matched by its shorter prefix's sigil, or vice versa", () => {
  assert.equal(
    routeSkillPrompt({ suite, prompt: "Use $linear-publish-spec-typo." })?.id,
    "linear-publish-spec-typo"
  );
  // The trailing terminator rejects `-typo` for the shorter id, so exactly one skill matches.
  assert.equal(
    routeSkillPrompt({ suite, prompt: "Use /linear-publish-spec-typo." })?.id,
    "linear-publish-spec-typo"
  );
});

test("semantic routing still works and stays independent of the sigil rule", () => {
  assert.equal(
    routeSkillPrompt({ suite, prompt: "please use linear-publish-spec now" })?.id,
    "linear-publish-spec"
  );
  assert.equal(routeSkillPrompt({ suite, prompt: "publish this spec to Linear" }), null);
});
