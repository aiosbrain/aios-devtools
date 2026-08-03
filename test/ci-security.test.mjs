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

// Top-level job blocks are keyed by a two-space-indented `<name>:` line; the block runs
// until the next such line (or EOF), minus any trailing blank/comment lines that are
// actually the lead-in commentary for the *next* job. Used to scope assertions to one job.
function jobBlock(workflow, jobName) {
  const lines = workflow.split("\n");
  const startIndex = lines.findIndex((line) => line === `  ${jobName}:`);
  if (startIndex === -1) return undefined;
  const nextTopLevel = lines
    .slice(startIndex + 1)
    .findIndex((line) => /^  [A-Za-z0-9_-]+:$/.test(line));
  let endIndex = nextTopLevel === -1 ? lines.length : startIndex + 1 + nextTopLevel;
  while (endIndex > startIndex + 1 && /^\s*(#.*)?$/.test(lines[endIndex - 1])) endIndex -= 1;
  return lines.slice(startIndex, endIndex).join("\n");
}

// The behaviorally meaningful lines of a job block: every line except pure comments and
// blank lines (trailing whitespace stripped). Comment-only edits, key reordering noise, and
// prose never affect this; any actual key/value/command does. Used for exact-match
// "allowlist" assertions instead of scanning for individual forbidden substrings — shell has
// unbounded ways to discard a non-zero exit (`|| :`, `; true`, `if ! cmd; then :; fi`,
// trailing `exit 0`, ...); asserting the one command that is allowed to run, verbatim,
// catches all of them by construction instead of requiring a new blacklist rule per idiom.
function significantLines(block) {
  return block
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
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

test("health upload failures are not retried with a destructive plain upload", () => {
  assert.doesNotMatch(
    scanWorkflow,
    /scan_with_health\.py[\s\S]*?\|\|\s+python -m aios_ingest\.cli scan/
  );
});

// AIO-699: the pinned `unit tests` job is the baseline toolkit-drift is measured against.
// Comparing only its pin SHA lets its *behavior* drift silently (e.g. its provisioning
// quietly gaining/losing --ignore-scripts) while looking untouched. Assert the properties
// that actually matter, then back them with a readable line-by-line snapshot — a diff of
// what changed, not an opaque hash two people have to trust blindly.
const PINNED_JOB_LINES = [
  "  test:",
  "    name: unit tests",
  "    runs-on: ubuntu-latest",
  "    permissions:",
  "      contents: read",
  "    steps:",
  "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          persist-credentials: false",
  "      - name: Checkout AIOS toolkit",
  "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          repository: aiosbrain/aios-workspace",
  "          ref: a48356602eb73c41b6945de8211aabc4064e8a65",
  "          path: toolkit-checkout",
  "          persist-credentials: false",
  "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
  "        with:",
  "          node-version: 22",
  "      - name: Install dependencies",
  "        run: |",
  '          if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi',
  "      - name: Provision toolkit (deps + operator-loop dist)",
  "        working-directory: toolkit-checkout",
  "        run: |",
  "          npm ci",
  "          npm run build:loop --if-present",
  "      - name: Test",
  "        env:",
  "          AIOS_TOOLKIT_DIR: ${{ github.workspace }}/toolkit-checkout",
  "        run: |",
  '          if [ -f package.json ]; then npm run test --if-present; else echo "no package.json — skipping tests"; fi',
];

test("AIO-699: the pinned `unit tests` job's contract is unchanged", () => {
  const pinnedJob = jobBlock(ciWorkflow, "test");
  assert.ok(pinnedJob, "the pinned `test` (unit tests) job must still exist");

  // Semantic properties that define "the pinned lane" — these are what toolkit-drift is
  // measured against, so each one is asserted independently, not folded into one hash.
  assert.match(
    pinnedJob,
    /ref: a48356602eb73c41b6945de8211aabc4064e8a65\b/,
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

  // Readable snapshot, not a hash: on mismatch, Node prints the actual line-by-line diff
  // against PINNED_JOB_LINES above, so a reviewer sees exactly what changed. If a change is
  // intentional (including an AIO-685 pin bump), update PINNED_JOB_LINES in the same PR —
  // copy the new lines straight out of this assertion's failure output.
  assert.deepEqual(
    significantLines(pinnedJob),
    PINNED_JOB_LINES,
    "the pinned `test` job changed — if intentional, paste the new lines from this diff into " +
      "PINNED_JOB_LINES in the same PR, with a note of what changed and why"
  );
});

// AIO-699: the toolkit-drift job's steps, verbatim. This is an allowlist, not a blacklist —
// any mutation to a run command, checkout target, or job setting produces a line that no
// longer matches one of these, so it fails by construction. That's what makes it catch
// idioms nobody has enumerated yet (`|| :`, `; true`, `if ! cmd; then :; fi`, a trailing
// `exit 0`, ...) instead of requiring a new forbidden-substring rule per idiom discovered.
const TOOLKIT_DRIFT_LINES = [
  "  toolkit-drift:",
  "    name: toolkit drift (advisory, core main)",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 15",
  "    permissions:",
  "      contents: read",
  "    steps:",
  "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          persist-credentials: false",
  "      - name: Checkout AIOS toolkit",
  "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          repository: aiosbrain/aios-workspace",
  "          ref: main",
  "          path: toolkit-checkout",
  "          persist-credentials: false",
  "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
  "        with:",
  "          node-version: 22",
  "      - name: Install dependencies",
  "        run: npm ci --ignore-scripts",
  "      - name: Provision toolkit (deps + operator-loop dist)",
  "        working-directory: toolkit-checkout",
  "        run: |",
  "          npm ci --ignore-scripts",
  "          npm run build:loop --if-present",
  "      - name: Test",
  "        env:",
  "          AIOS_TOOLKIT_DIR: ${{ github.workspace }}/toolkit-checkout",
  "        run: |",
  '          if [ -f package.json ]; then npm run test --if-present; else echo "no package.json — skipping tests"; fi',
];

test("AIO-699 toolkit-drift lane matches its allowlisted steps exactly", () => {
  const driftJob = jobBlock(ciWorkflow, "toolkit-drift");
  assert.ok(driftJob, "the AIO-699 toolkit-drift job must exist");

  // Exact-match allowlist on every behaviorally meaningful line in the job. This is
  // strictly stronger than scanning for forbidden substrings (continue-on-error, `|| true`,
  // `|| exit 0`, `set +e`, ...): none of those substrings need to be enumerated here,
  // because any of them — or any other exit-swallowing idiom — changes a run-step line
  // away from what TOOLKIT_DRIFT_LINES says is the only thing allowed to run.
  assert.deepEqual(
    significantLines(driftJob),
    TOOLKIT_DRIFT_LINES,
    "toolkit-drift's steps no longer match the allowlisted contract — if intentional, paste " +
      "the new lines from this diff into TOOLKIT_DRIFT_LINES in the same PR"
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
