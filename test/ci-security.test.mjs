import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

test("all third-party Actions are immutable-SHA pinned and checkout drops credentials", () => {
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/);
  const checkoutCount = uses.filter((action) => action.startsWith("actions/checkout@")).length;
  assert.equal(
    [...workflow.matchAll(/uses: actions\/checkout@[0-9a-f]{40}[\s\S]*?persist-credentials:\s*false/g)]
      .length,
    checkoutCount
  );
});

test("private leak-term secret is scoped only to protected-main steps", () => {
  const secretUses = workflow.split("\n").filter((line) => line.includes("secrets.AIOS_LEAK_TERMS_B64"));
  assert.equal(secretUses.length, 2);
  assert.match(workflow, /Baseline confidentiality leak gate[\s\S]*AIOS_LEAK_TERMS_B64: ""/);
  for (const name of [
    "Assert private leak terms present on protected main",
    "Private confidentiality term scan on protected main",
  ]) {
    const step = workflow.slice(workflow.indexOf(`- name: ${name}`));
    assert.match(step.split(/\n\s*- name:/, 1)[0], /github\.event_name == 'push'.*refs\/heads\/main/);
  }
});
