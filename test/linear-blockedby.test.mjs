// test/linear-blockedby.test.mjs — [R-Major-2] proven blockedBy direction.
// "AIO-X blocked by AIO-Y" lives on inverseRelations (type "blocks", relation.issue = Y);
// "AIO-X blocks AIO-Z" lives on relations (type "blocks", relatedIssue = Z) and is NOT a
// blocker of X. isUnblocked is false until every blockedBy blocker is completed.
//
// AIO-662 (moved from aios-workspace): isUnblocked is roadmap-run.mjs's eligibility gate —
// devtools. normalizeBlockedBy is the published @aiosbrain/foundation/linear-client shape it
// consumes, so both sides of the direction contract are assertable here with no toolkit.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBlockedBy } from "@aiosbrain/foundation/linear-client";
import { isUnblocked } from "../scripts/roadmap-run.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));

const fixture = JSON.parse(
  readFileSync(path.join(DIR, "fixtures", "linear", "relations-both-directions.json"), "utf8")
);

test("normalizeBlockedBy — both directions", () => {
  const blockedBy = normalizeBlockedBy(fixture);
  assert.equal(blockedBy.length, 1, "exactly one blocker");
  assert.equal(blockedBy[0].identifier, "AIO-200", "blocker is AIO-200 (the inverseRelation)");
  assert.equal(blockedBy[0].stateType, "started", "blocker state carried");
  // AIO-300 (the forward "blocks" relation) must NOT appear — X blocks Z, Z does not block X.
  assert.ok(
    !blockedBy.some((b) => b.identifier === "AIO-300"),
    "AIO-300 (forward relation) is not a blocker"
  );
});

test("isUnblocked follows blockedBy state", () => {
  const blocked = { blockedBy: normalizeBlockedBy(fixture) };
  assert.equal(isUnblocked(blocked), false, "blocked while AIO-200 is started");

  // Same shape but the blocker is now completed.
  const doneBlocker = {
    inverseRelations: {
      nodes: [{ type: "blocks", issue: { identifier: "AIO-200", state: { type: "completed" } } }],
    },
  };
  const unblocked = { blockedBy: normalizeBlockedBy(doneBlocker) };
  assert.equal(isUnblocked(unblocked), true, "unblocked once AIO-200 is completed");

  assert.equal(isUnblocked({ blockedBy: [] }), true, "no blockers → unblocked");
});

test("forward-only blocks → not blocked", () => {
  const forwardOnly = {
    relations: {
      nodes: [
        { type: "blocks", relatedIssue: { identifier: "AIO-Z", state: { type: "unstarted" } } },
      ],
    },
    inverseRelations: { nodes: [] },
  };
  const bb = normalizeBlockedBy(forwardOnly);
  assert.equal(bb.length, 0, "forward 'blocks' yields empty blockedBy");
  assert.equal(isUnblocked({ blockedBy: bb }), true, "isUnblocked true for a pure blocker");
});
