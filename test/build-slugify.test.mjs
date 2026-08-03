// test/build-slugify.test.mjs — build.mjs's BOUND slugify form.
//
// AIO-662 (split out of aios-workspace's test/cli-common.test.mjs): core keeps the UNBOUND
// base semantics of `slugify` (no clamp, no fallback, null-safe) pinned against
// scripts/cli-common.mjs; what belongs here is the devtools-owned BINDING — build.mjs
// exports `slugify` bound with { maxLen: 40, fallback: "task" }, and the branch/worktree
// names it produces are load-bearing for the build phase.

import test from "node:test";
import assert from "node:assert/strict";
import { slugify as buildSlugify } from "../scripts/build.mjs";

test("slugify — build.mjs bound form { maxLen: 40, fallback: 'task' }", () => {
  assert.equal(
    buildSlugify("Add an aios Build Phase!! (v2)"),
    "add-an-aios-build-phase-v2",
    "lowercases + hyphenates (build)"
  );
  assert.equal(buildSlugify(""), "task", "empty → task (build)");
  assert.ok(buildSlugify("x".repeat(100)).length <= 40, "caps length ≤ 40 (build)");
});
