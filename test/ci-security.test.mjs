import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = path.join(root, ".github", "workflows");
const workflows = new Map(
  readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, readFileSync(path.join(workflowsDir, name), "utf8")])
);
const ciWorkflow = workflows.get("ci.yml");
const scanWorkflow = workflows.get("scan-on-merge.yml");

function workflowSteps(workflow) {
  const lines = workflow.split("\n");
  const starts = lines.flatMap((line, index) => (/^      - /.test(line) ? [index] : []));
  return starts.map((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length).join("\n")
  );
}

test("all workflows SHA-pin third-party Actions and every checkout drops credentials", () => {
  let externalActionCount = 0;
  let checkoutCount = 0;
  for (const [name, workflow] of workflows) {
    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map(
      (match) => match[1]
    );
    for (const action of uses) {
      if (action.startsWith("./")) continue;
      externalActionCount += 1;
      assert.match(action, /@[0-9a-f]{40}$/, `${name}: ${action} is not immutable`);
    }
    for (const step of workflowSteps(workflow).filter((candidate) =>
      /uses: actions\/checkout@/.test(candidate)
    )) {
      checkoutCount += 1;
      assert.match(step, /^\s+(?:- )?uses: actions\/checkout@[0-9a-f]{40}/m);
      assert.match(step, /^          persist-credentials: false$/m, name);
    }
  }
  assert.ok(externalActionCount > 0);
  assert.ok(checkoutCount > 0);
});

test("private leak-term secret is scoped only to protected-main steps", () => {
  const secretUses = ciWorkflow
    .split("\n")
    .filter((line) => line.includes("secrets.AIOS_LEAK_TERMS_B64"));
  assert.equal(secretUses.length, 2);
  assert.match(ciWorkflow, /Baseline confidentiality leak gate[\s\S]*AIOS_LEAK_TERMS_B64: ""/);
  for (const name of [
    "Assert private leak terms present on protected main",
    "Private confidentiality term scan on protected main",
  ]) {
    const step = workflowSteps(ciWorkflow).find((candidate) => candidate.includes(`- name: ${name}`));
    assert.ok(step, `missing workflow step: ${name}`);
    assert.match(
      step,
      /^        if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m
    );
    assert.match(step, /secrets\.AIOS_LEAK_TERMS_B64/);
  }
});

test("Brain credentials cannot reach checkout, installs, builds, or coverage", () => {
  assert.ok(scanWorkflow, "scan-on-merge.yml must exist");
  assert.doesNotMatch(scanWorkflow, /^    env:\n(?:^      .+\n)+/m, "job-scoped env is forbidden");

  const credentialSteps = workflowSteps(scanWorkflow).filter((step) =>
    /secrets\.AIOS_(?:API_KEY|BRAIN_URL|TEAM)/.test(step)
  );
  assert.equal(credentialSteps.length, 2);
  assert.match(credentialSteps[0], /- name: Check Brain configuration/);
  assert.match(credentialSteps[1], /- name: Scan this workspace into the brain/);

  for (const step of workflowSteps(scanWorkflow).filter((candidate) =>
    /(?:uses:|npm (?:ci|install)|pip install|coverage|codebase health|Fetch the ingestion)/i.test(candidate)
  )) {
    if (/Check Brain configuration|Scan this workspace into the brain/.test(step)) continue;
    assert.doesNotMatch(step, /secrets\./, "setup step unexpectedly receives a secret");
    assert.doesNotMatch(step, /^\s+AIOS_API_KEY:/m);
  }
});

test("the secret-bearing scan can run only after a push to protected main", () => {
  assert.match(scanWorkflow, /^on:\n {2}push:\n {4}branches: \[main\]$/m);
  assert.doesNotMatch(scanWorkflow, /workflow_dispatch/);
  assert.doesNotMatch(scanWorkflow, /pull_request(?:_target)?:/);
});

test("scan dependencies are immutable and install without lifecycle/source builds", () => {
  assert.match(scanWorkflow, /npm install -g @aiosbrain\/aios@0\.9\.1 --ignore-scripts/);
  assert.match(scanWorkflow, /npm ci --ignore-scripts/);
  assert.doesNotMatch(scanWorkflow, /npm ci \|\| npm install/);
  assert.match(scanWorkflow, /pip install --only-binary=:all: --require-hashes/);
  assert.doesNotMatch(scanWorkflow, /pip install -e/);

  const requirements = readFileSync(
    path.join(root, ".github", "scripts", "brain-scanner-requirements.txt"),
    "utf8"
  );
  const requirementLines = requirements.split("\n").filter((line) => /^[a-z]/.test(line));
  assert.ok(requirementLines.length > 0);
  for (const line of requirementLines) assert.match(line, /^[a-z][a-z0-9-]*==[^ ]+ \\$/);
  assert.equal((requirements.match(/--hash=sha256:[0-9a-f]{64}/g) ?? []).length, requirementLines.length);
});

test("optional coverage dependency failures do not abort the Brain scan", () => {
  assert.match(
    scanWorkflow,
    /if npm ci --ignore-scripts; then[\s\S]*?npm run test:coverage \|\| true/
  );
  assert.match(
    scanWorkflow,
    /else\n\s+echo "dependency install failed — continuing without a coverage report\."/
  );
});

test("the exact toolkit pin resolves from the public npm registry", () => {
  const match = scanWorkflow.match(
    /npm install -g (@aiosbrain\/aios@(\d+\.\d+\.\d+)) --ignore-scripts/
  );
  assert.ok(match, "missing exact toolkit install pin");
  const [, specifier, expectedVersion] = match;
  const result = spawnSync("npm", ["view", specifier, "version", "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(JSON.parse(result.stdout), expectedVersion);
});
