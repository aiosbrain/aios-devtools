#!/usr/bin/env node
// scripts/cli.mjs — the stable `aios-devtools` bin (AIO-594 PR A).
//
// Dispatches the five public devtools command names to their implementation modules,
// IN-PROCESS — exactly the way the aios-workspace front door runs these modules today
// (scripts/cli/registry.mjs `adapt: (ctx, mod) => mod.cmdX(ctx.repo, ctx.rest)`). Because
// the command runs in this process, argv, cwd, environment, stdio, exit codes, and
// termination signals are inherently the command's own — nothing is proxied or
// reinterpreted, and this file never parses command-specific flags (each module owns its
// flags, including --toolkit-dir; see docs/devtools-toolkit-contract.md).
//
// Command modules are loaded lazily so `aios-devtools --help` stays instant and never
// touches the toolkit seam.
//
// The aios-workspace `aios` front door remains authoritative for its own help output and
// registry resolution modes; this bin is the standalone package's stable entry, and the
// seam a future Workspace dispatch adapter can delegate to.

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// name → { load: lazy module import, entry: exported command function }.
// Exit semantics match the in-monorepo dispatch: build/spec own their process.exit;
// the other three return an exit code (registry `exit: "exit-code"`).
const COMMANDS = {
  build: { load: () => import("./build.mjs"), entry: "cmdBuild" },
  spec: { load: () => import("./spec-eval.mjs"), entry: "cmdSpec" },
  "consolidate-findings": {
    load: () => import("./consolidate-findings.mjs"),
    entry: "cmdConsolidateFindings",
  },
  ship: { load: () => import("./ship.mjs"), entry: "cmdShip" },
  "roadmap-run": { load: () => import("./roadmap-run.mjs"), entry: "cmdRoadmapRun" },
};

const USAGE = `
aios-devtools — the AIOS devtools command set (@aiosbrain/aios-devtools)

usage:
  aios-devtools <command> [args...]

commands:
  build                  implement an approved plan with a build/review loop
  spec                   spec-eval: grade a spec against the readiness rubric
  consolidate-findings   consolidate PR review findings into one verdict
  ship                   staged ship pipeline for a Linear issue
  roadmap-run            run eligible roadmap issues from a Linear source

Each command owns its flags — run \`aios-devtools <command> --help\`.

toolkit seam:
  Toolkit-dependent functionality resolves an AIOS toolkit checkout via
  --toolkit-dir <path> (per command) or AIOS_TOOLKIT_DIR in the environment.
  Contract: docs/devtools-toolkit-contract.md.
`;

/** Nearest enclosing repo root (.git or aios.yaml marker), or null. Mirrors the
 *  direct-entrypoint resolution already used by scripts/consolidate-findings.mjs. */
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git")) || existsSync(path.join(dir, "aios.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function packageVersion() {
  const pkg = JSON.parse(readFileSync(path.join(SCRIPT_DIR, "..", "package.json"), "utf8"));
  return `${pkg.name} ${pkg.version}`;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${packageVersion()}\n`);
    process.exit(0);
  }

  const descriptor = COMMANDS[command];
  if (!descriptor) {
    process.stderr.write(
      `error: unknown command '${command}' — expected one of: ${Object.keys(COMMANDS).join(", ")}.\n` +
        "Run `aios-devtools --help` for usage.\n"
    );
    process.exit(1);
  }

  const repo = findRepoRoot(process.cwd()) ?? process.cwd();
  const mod = await descriptor.load();
  // build/spec call process.exit themselves; the rest return a numeric exit code.
  const code = await mod[descriptor.entry](repo, rest);
  process.exit(typeof code === "number" ? code : 0);
}

main().catch((e) => {
  process.stderr.write(`aios-devtools: error: ${e?.message ?? String(e)}\n`);
  process.exit(1);
});
