import test from "node:test";
import assert from "node:assert/strict";

import { parseBuildArgs } from "../scripts/build.mjs";
import { parseRoadmapArgs } from "../scripts/roadmap-run.mjs";
import { parseConsolidateArgs } from "../scripts/consolidate-findings.mjs";
import { cmdShip, SHIP_EXIT } from "../scripts/ship.mjs";
import { cmdSpec } from "../scripts/spec-eval.mjs";
import { cmdSpecPublish, SpecPublishError } from "../scripts/spec-publish.mjs";

const selector = ["--toolkit-dir", "/tmp/aios-toolkit"];

test("build positional parsing ignores toolkit selector before and after positions", () => {
  assert.deepEqual(
    [parseBuildArgs([...selector, "plan.md", "feat/x"]), parseBuildArgs(["plan.md", "feat/x", ...selector])].map(
      ({ planSource, branch }) => ({ planSource, branch })
    ),
    [
      { planSource: "plan.md", branch: "feat/x" },
      { planSource: "plan.md", branch: "feat/x" },
    ]
  );
});

test("roadmap and consolidate parsers ignore the toolkit selector", () => {
  assert.equal(parseRoadmapArgs([...selector, "--epic", "AIO-594"]).sourceValue, "AIO-594");
  assert.equal(parseConsolidateArgs(["--pr", "19", ...selector]).pr, "19");
});

test("ship and spec help tolerate a leading toolkit selector", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await cmdShip(process.cwd(), [...selector, "--help"]), SHIP_EXIT.OK);
    assert.equal(await cmdSpec(process.cwd(), [...selector, "--help"]), undefined);
  } finally {
    console.log = log;
  }
});

test("spec-publish removes toolkit selector before its fixed command positions", async () => {
  await assert.rejects(
    cmdSpecPublish(process.cwd(), ["publish", ...selector]),
    (error) => error instanceof SpecPublishError && /^usage:/.test(error.message)
  );
});
