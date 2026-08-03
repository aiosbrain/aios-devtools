// test/template-spec-readiness.test.mjs — the aios-issue-template ↔ spec-eval contract:
// the canonical template path resolves, an UNFILLED template must trip deterministic SR3
// (placeholder integration path), a FILLED one is deterministic-clean, and `spec init` /
// renderAiosIssueTemplate produce the scaffold.
//
// AIO-662 (moved from aios-workspace): resolveAiosIssueTemplate / renderAiosIssueTemplate /
// runDeterministicChecks and the `spec` command are all devtools (scripts/spec-eval.mjs), so
// the contract test belongs here. Two adaptations for the standalone repo:
//   - the template body itself is core-owned content (docs/agentic-ergonomics/), so it is
//     staged from an AIOS toolkit checkout at runtime rather than vendored
//     (docs/devtools-toolkit-contract.md) — every test skips with a named reason without one;
//   - the CLI spawned is the devtools bin `scripts/cli.mjs` (which derives `repo` from cwd)
//     instead of core's `scripts/aios.mjs --repo`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageSpecWorkspace, toolkitFile, toolkitSkip } from "./fixture-workspace.mjs";
import {
  runDeterministicChecks,
  renderAiosIssueTemplate,
  resolveAiosIssueTemplate,
  AIOS_ISSUE_TEMPLATE_REL,
} from "../scripts/spec-eval.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DEVTOOLS_ROOT = path.join(DIR, "..");
const CLI = path.join(DEVTOOLS_ROOT, "scripts", "cli.mjs");
const FILLED = path.join(DIR, "fixtures", "spec-eval", "aios-issue-filled.md");

// The standard staged spec workspace (core rubric + delivery skill suite + the devtools files
// the fixtures name as integration points, and the `aios.yaml` marker the devtools bin resolves
// `repo` by), plus the core-owned aios-issue-template at its canonical relative path.
function stageTemplateWorkspace() {
  const base = stageSpecWorkspace();
  if (!base.dir) return base;
  const src = toolkitFile(AIOS_ISSUE_TEMPLATE_REL);
  if (!src) {
    return { dir: null, skip: toolkitSkip(`the aios-issue-template (${AIOS_ISSUE_TEMPLATE_REL})`) };
  }
  // Core-owned integration points the filled fixture names (SR3 resolves them against `repo`).
  const LINEAR_SKILL_REL = path.join(
    "scaffold",
    ".claude",
    "skills",
    "aios-linear",
    "linear.mjs"
  );
  const linear = toolkitFile(LINEAR_SKILL_REL);
  if (!linear) return { dir: null, skip: toolkitSkip(`the aios-linear scaffold skill`) };
  for (const [from, rel] of [
    [src, AIOS_ISSUE_TEMPLATE_REL],
    [linear, LINEAR_SKILL_REL],
  ]) {
    const dst = path.join(base.dir, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    cpSync(from, dst);
  }
  return base;
}

const WS = stageTemplateWorkspace();
const SKIP = WS.skip || false;
const REPO = WS.dir ?? DEVTOOLS_ROOT;
const TEMPLATE = path.join(REPO, AIOS_ISSUE_TEMPLATE_REL);

function runSpec(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, "spec", ...args], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("canonical aios-issue-template path resolves", { skip: SKIP }, () => {
  assert.equal(resolveAiosIssueTemplate(REPO), TEMPLATE);
  assert.ok(existsSync(TEMPLATE));
});

test(
  "unfilled template fails deterministic SR3 (placeholder integration path)",
  { skip: SKIP },
  () => {
    const text = readFileSync(TEMPLATE, "utf8");
    const findings = runDeterministicChecks(text, { repo: REPO });
    const blockers = findings.filter((f) => f.severity === "blocker");
    assert.ok(
      blockers.some((f) => f.ruleId === "SR3"),
      blockers.map((f) => f.detail).join("; ")
    );
  }
);

test(
  "filled aios-issue fixture is deterministic-clean (default tier → exit 0)",
  { skip: SKIP },
  () => {
    // Since AIO-573 the adversarial layer is opt-in, so a fixture that declares no `eval_tier`
    // runs the deterministic layer alone and a clean result is a COMPLETE answer: SPEC_READY / 0,
    // not NOT_EVALUATED / 3. Exit 3 now means "the spec asked for the LLM layer and it did not run".
    const r = runSpec(["eval", FILLED, "--no-llm", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.verdict, "SPEC_READY");
    assert.equal(j.tier, "deterministic");
    const blockers = (j.findings || []).filter((f) => f.severity === "blocker");
    assert.equal(blockers.length, 0, blockers.map((f) => f.detail).join("; "));
  }
);

test("aios spec init writes scaffold with optional title", { skip: SKIP }, () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-init-"));
  try {
    const target = path.join(d, "nested", "issue.md");
    const r = runSpec(["init", target, "--title", "My slice"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(target));
    const text = readFileSync(target, "utf8");
    assert.match(text, /^# My slice/m);
    assert.match(text, /## What \/ why/);
    assert.match(text, /## Outcomes/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("renderAiosIssueTemplate substitutes title", { skip: SKIP }, () => {
  const text = renderAiosIssueTemplate(REPO, { title: "Agentic Linear factory" });
  assert.match(text, /^# Agentic Linear factory/m);
});
