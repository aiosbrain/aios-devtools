// Tests for scripts/cli.mjs — the stable `aios-devtools` bin (AIO-594 PR A).
// Dispatch semantics only: help listing, unknown-command diagnostics, exit-code
// propagation from a dispatched command. Command-specific behavior is owned by the
// per-command suites.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "scripts", "cli.mjs");
const PUBLIC_COMMANDS = ["build", "spec", "consolidate-findings", "ship", "roadmap-run"];

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: repoRoot,
    ...options,
  });
}

test("--help lists exactly the five public commands and the toolkit seam, exit 0", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  for (const name of PUBLIC_COMMANDS) {
    assert.match(r.stdout, new RegExp(`^  ${name} `, "m"), `--help must list ${name}`);
  }
  assert.match(r.stdout, /AIOS_TOOLKIT_DIR/);
  assert.match(r.stdout, /--toolkit-dir/);
  assert.match(r.stdout, /docs\/devtools-toolkit-contract\.md/);
});

test("no arguments → usage on stderr, non-zero exit", () => {
  const r = runCli([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage:/);
});

test("unknown command → actionable error naming the valid set, non-zero exit", () => {
  const r = runCli(["frobnicate"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command 'frobnicate'/);
  for (const name of PUBLIC_COMMANDS) {
    assert.ok(r.stderr.includes(name), `unknown-command error must name ${name}`);
  }
  assert.match(r.stderr, /aios-devtools --help/);
});

test("--version prints the package name + version, exit 0", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const r = runCli(["--version"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), `${pkg.name} ${pkg.version}`);
});

test("exit-code propagation: dispatched command's success (0) is preserved", () => {
  // cmdBuild prints usage and returns cleanly on --help — the bin must exit 0,
  // with the command's own stdout untouched.
  const r = runCli(["build", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /aios build/);
});

test("exit-code propagation: dispatched command's failure (non-zero) is preserved", () => {
  // cmdRoadmapRun([]) fails its exactly-one-source arg contract and returns 1 —
  // offline, deterministic, and the error text is the command's own (not reparsed).
  const r = runCli(["roadmap-run"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: exactly one source is required/);
});

test("package root export exposes the command entry points + relay-support surface", async () => {
  const root = await import("../scripts/index.mjs");
  const expected = [
    // the five command entry points
    "cmdBuild",
    "cmdSpec",
    "cmdConsolidateFindings",
    "cmdShip",
    "cmdRoadmapRun",
    // relay-support: what aios-workspace scripts/relay.mjs imports from build.mjs
    "runBuild",
    "parseBuildArgs",
    // relay-support: what aios-workspace scripts/relay.mjs imports from spec-eval.mjs
    "evaluateSpec",
    "loadRubric",
    "loadRecentDecisions",
    "formatFindings",
    "specEvalHints",
  ];
  for (const name of expected) {
    assert.equal(typeof root[name], "function", `root export missing function ${name}`);
  }
});

test("package.json exports map covers the root, the bin module, and the five commands", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.private, undefined, "package must not be private (installable)");
  assert.equal(pkg.bin?.["aios-devtools"], "scripts/cli.mjs");
  assert.equal(pkg.exports?.["."], "./scripts/index.mjs");
  assert.equal(pkg.exports?.["./cli"], "./scripts/cli.mjs");
  const subpaths = {
    "./build": "./scripts/build.mjs",
    "./spec-eval": "./scripts/spec-eval.mjs",
    "./consolidate-findings": "./scripts/consolidate-findings.mjs",
    "./ship": "./scripts/ship.mjs",
    "./roadmap-run": "./scripts/roadmap-run.mjs",
  };
  for (const [subpath, target] of Object.entries(subpaths)) {
    assert.equal(pkg.exports?.[subpath], target, `exports map must expose ${subpath}`);
  }
});
