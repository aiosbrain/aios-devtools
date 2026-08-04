import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  jobBlock,
  readCiContract,
  repoRoot as root,
  significantLines,
  workflowSteps,
} from "./workflow-contract-lib.mjs";

const workflowsDir = path.join(root, ".github", "workflows");
const workflows = new Map(
  readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, readFileSync(path.join(workflowsDir, name), "utf8")])
);
const ciWorkflow = workflows.get("ci.yml");
const scanWorkflow = workflows.get("scan-on-merge.yml");

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

test("health upload failures are not retried with a destructive plain upload", () => {
  assert.doesNotMatch(
    scanWorkflow,
    /scan_with_health\.py[\s\S]*?\|\|\s+python -m aios_ingest\.cli scan/
  );
});

// AIO-699: the pin this whole lane exists to police. Named once so the SHA assertion below
// and the bump instructions point at the same single source of truth — bumping the pin (per
// docs/devtools-toolkit-contract.md's reconcile-then-bump procedure) means updating THIS
// constant AND the `ref:` line in the frozen workflow contract together, in the same PR.
// Neither one alone passes: change only the constant and this test fails; change only the
// workflow and the contract test below fails.
const PINNED_TOOLKIT_SHA = "a48356602eb73c41b6945de8211aabc4064e8a65";

test("AIO-699: the pinned `unit tests` job's contract is unchanged", () => {
  const pinnedJob = jobBlock(ciWorkflow, "test");
  assert.ok(pinnedJob, "the pinned `test` (unit tests) job must still exist");

  // Semantic properties that define "the pinned lane" — these are what toolkit-drift is
  // measured against, so each one is asserted independently, not folded into one hash.
  assert.match(
    pinnedJob,
    new RegExp(`ref: ${PINNED_TOOLKIT_SHA}\\b`),
    "the AIO-685 pin must remain exact-SHA and untouched"
  );
  assert.match(pinnedJob, /repository: aiosbrain\/aios-workspace/, "checkout target unchanged");
  assert.match(pinnedJob, /path: toolkit-checkout/, "checkout path unchanged");
  assert.match(
    pinnedJob,
    /^          if \[ -f package-lock\.json \]; then npm ci; elif \[ -f package\.json \]; then npm install; fi$/m,
    "devtools-side install command unchanged"
  );
  assert.match(
    pinnedJob,
    /^          npm ci$/m,
    "toolkit provisioning install must stay plain `npm ci` (no flags silently added or removed)"
  );
  assert.doesNotMatch(
    pinnedJob,
    /npm ci --ignore-scripts/,
    "the pinned lane's install behavior must not silently change"
  );
  assert.match(pinnedJob, /npm run build:loop --if-present/, "operator-loop build step unchanged");
  assert.match(
    pinnedJob,
    /^          if \[ -f package\.json \]; then npm run test --if-present; else echo "no package\.json — skipping tests"; fi$/m,
    "unconditional test invocation unchanged"
  );
});

test("AIO-699: the toolkit-drift lane tracks core main and is bounded", () => {
  const driftJob = jobBlock(ciWorkflow, "toolkit-drift");
  assert.ok(driftJob, "the AIO-699 toolkit-drift job must exist");
  assert.match(driftJob, /^          ref: main$/m, "the drift lane must track core main, never a pin");
  assert.match(driftJob, /repository: aiosbrain\/aios-workspace/, "checkout target unchanged");
  assert.match(
    driftJob,
    /^    timeout-minutes: 15$/m,
    "a lane that installs and builds from floating core must stay bounded"
  );
  assert.match(
    driftJob,
    /^        run: npm ci --ignore-scripts$/m,
    "floating core's install-time lifecycle scripts are unreviewed and must stay disabled"
  );
});

/**
 * THE CONTRACT. Every behaviorally meaningful line of ci.yml, frozen.
 *
 * This is one exact-match allowlist over the WHOLE FILE, and it replaced two per-job
 * allowlists that adversarial review defeated at e5b2053 — not by finding a hole inside
 * either job, but by changing things outside them:
 *
 *   - `defaults: {run: {shell: bash -c 'bash "$0" || true' {0}}}` at WORKFLOW level. GitHub
 *     applies that to every `run` step in every job, so it swallowed a script exiting 23 in
 *     both allowlisted jobs while changing nothing inside either job block. PyYAML and
 *     actionlint both accepted it and the whole suite stayed green.
 *   - `|| true` appended to both confidentiality leak scans in `gates`, a job no allowlist
 *     covered at all — leaving the security gate free to report success after finding
 *     confidential material. Also green.
 *   - the same trick on `lint`, `test-no-toolkit` and `pack-verify`, all likewise uncovered.
 *
 * The fix is NOT a forbidden-substring rule for `defaults:`/`shell:`. That is the same
 * blacklist mistake one level up, over a syntax (GitHub's) this repo neither controls nor
 * can exhaust — and enumerating bad inputs is exactly what this contract was inverted away
 * from in the first place. The fix is scope: allowlist the entire file, so any behaviorally
 * meaningful line ANYWHERE — top-level keys included — has to be in the frozen contract.
 *
 * Cost: an intentional ci.yml edit must update test/fixtures/ci-workflow-contract.txt in the
 * same PR. That is the point. Regenerate with
 *
 *     node test/workflow-contract-lib.mjs > test/fixtures/ci-workflow-contract.txt
 *
 * and read the diff before you do — this file is the only thing between a swallowed exit
 * status and a green check.
 */
test("every behaviorally meaningful line of ci.yml matches the frozen contract", () => {
  assert.deepEqual(
    significantLines(ciWorkflow),
    readCiContract(),
    "ci.yml no longer matches test/fixtures/ci-workflow-contract.txt. Read this diff line by " +
      "line: anything that changes what a step RUNS, or how its exit status is interpreted " +
      "(defaults, shell, continue-on-error, a swallowed exit), is a security change. If every " +
      "changed line is intended, regenerate the fixture in this same PR with " +
      "`node test/workflow-contract-lib.mjs > test/fixtures/ci-workflow-contract.txt`."
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
