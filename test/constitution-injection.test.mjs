// test/constitution-injection.test.mjs — the DEVTOOLS half of aios-workspace's
// test/constitution.test.mjs (AIO-662 split). The engineering-constitution digest LOADER
// (extractDigest / loadConstitutionDigest / constitutionPromptLines) is core and its unit
// tests stay in aios-workspace; what moves here is the assertion that the digest is injected
// into the devtools prompt builders — buildPlanPrompt + buildGptReviewPrompt (ship.mjs) and
// buildImplementPrompt (build.mjs). The digest is a plain string, so no toolkit is needed.

import test from "node:test";
import assert from "node:assert/strict";
import { buildPlanPrompt, buildGptReviewPrompt } from "../scripts/ship.mjs";
import { buildImplementPrompt } from "../scripts/build.mjs";

const DIGEST = "- Domains are siblings, not friends.\n- Tier safety is non-negotiable.";

test("plan prompt injection (ship.mjs buildPlanPrompt)", () => {
  const issue = { identifier: "AIO-1", title: "t", description: "d" };
  const withC = buildPlanPrompt(issue, "pack", null, DIGEST);
  const withoutC = buildPlanPrompt(issue, "pack", null);
  assert.ok(withC.includes(DIGEST), "plan prompt carries digest");
  assert.ok(
    !withoutC.includes("Engineering constitution"),
    "plan prompt unchanged without digest"
  );
});

test("review prompt injection (ship.mjs buildGptReviewPrompt)", () => {
  const rev = buildGptReviewPrompt("plan", "diff", 7, DIGEST);
  assert.ok(rev.includes(DIGEST), "review prompt carries digest");
  assert.ok(
    rev.includes("violates the constitution"),
    "review prompt flags violations as findings"
  );
  assert.ok(
    !buildGptReviewPrompt("plan", "diff", 7).includes("Engineering constitution"),
    "review prompt unchanged without digest"
  );
});

test("implement prompt injection (build.mjs buildImplementPrompt)", () => {
  const impl = buildImplementPrompt("PLAN", { branch: "b", constitution: DIGEST });
  assert.ok(impl.includes(DIGEST), "implement prompt carries digest");
  assert.ok(
    impl.indexOf(DIGEST) < impl.indexOf("When done, briefly summarize"),
    "digest sits before the wrap-up instruction"
  );
  const implResume = buildImplementPrompt("PLAN", {
    branch: "b",
    constitution: DIGEST,
    resumeLog: "abc earlier work",
  });
  assert.ok(
    implResume.indexOf("earlier work") < implResume.indexOf("## Rules"),
    "resume splice unaffected: resume block stays before Rules"
  );
  assert.ok(
    !buildImplementPrompt("PLAN", { branch: "b" }).includes("Engineering constitution"),
    "implement prompt unchanged without digest"
  );
});
