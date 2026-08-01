import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

function workflowSteps() {
  const lines = workflow.split("\n");
  const starts = lines.flatMap((line, index) => (/^      - /.test(line) ? [index] : []));
  return starts.map((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length).join("\n")
  );
}

test("all third-party Actions are immutable-SHA pinned and checkout drops credentials", () => {
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/);
  const checkouts = workflowSteps().filter((step) => /uses: actions\/checkout@/.test(step));
  assert.equal(checkouts.length, 4);
  for (const step of checkouts) {
    assert.match(step, /^\s+(?:- )?uses: actions\/checkout@[0-9a-f]{40}/m);
    assert.match(step, /^          persist-credentials: false$/m);
  }
});

test("private leak-term secret is scoped only to protected-main steps", () => {
  const secretUses = workflow.split("\n").filter((line) => line.includes("secrets.AIOS_LEAK_TERMS_B64"));
  assert.equal(secretUses.length, 2);
  assert.match(workflow, /Baseline confidentiality leak gate[\s\S]*AIOS_LEAK_TERMS_B64: ""/);
  for (const name of [
    "Assert private leak terms present on protected main",
    "Private confidentiality term scan on protected main",
  ]) {
    const step = workflowSteps().find((candidate) => candidate.includes(`- name: ${name}`));
    assert.ok(step, `missing workflow step: ${name}`);
    assert.match(
      step,
      /^        if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m
    );
    assert.match(step, /secrets\.AIOS_LEAK_TERMS_B64/);
  }
});
