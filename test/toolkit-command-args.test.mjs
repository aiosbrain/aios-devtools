import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { cmdBuild, parseBuildArgs } from "../scripts/build.mjs";
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

test("build, ship, and spec help tolerate a leading toolkit selector", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await cmdBuild(process.cwd(), [...selector, "--help"]), undefined);
    assert.equal(await cmdShip(process.cwd(), [...selector, "--help"]), SHIP_EXIT.OK);
    assert.equal(await cmdSpec(process.cwd(), [...selector, "--help"]), undefined);
  } finally {
    console.log = log;
  }
});

test("spec-publish removes toolkit selector before its fixed command positions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-spec-publish-toolkit-args-"));
  const candidate = path.join(dir, "candidate.md");
  const evaluation = path.join(dir, "evaluation.json");
  writeFileSync(candidate, "# Candidate\n");
  writeFileSync(
    evaluation,
    JSON.stringify({
      verdict: "SPEC_READY",
      exitCode: 0,
      tier: "full",
      publishable: true,
      candidateSha256: "f".repeat(64),
      repoSha: "a".repeat(40),
      repoDirty: false,
    })
  );
  const commandArgs = [
    "publish",
    "AIO-594",
    candidate,
    "--eval-artifact",
    evaluation,
    "--expected-remote-sha",
    "0".repeat(64),
    "--confirm-exclusive-editor",
  ];
  try {
    for (const args of [[...selector, ...commandArgs], [...commandArgs, ...selector]]) {
      await assert.rejects(
        cmdSpecPublish(process.cwd(), args, { linear: {} }),
        (error) =>
          error instanceof SpecPublishError && error.message === "candidate hash does not match the evaluation artifact"
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
