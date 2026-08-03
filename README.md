# aios-devtools

The AIOS devtools command set — `ship`, `build`, `roadmap-run`, `spec-eval`,
`spec-publish`, `consolidate-findings` — split out of the AIOS workspace toolkit.

## Installation

Published as **`@aiosbrain/aios-devtools`** (not yet on the npm registry — until the
first publish, install from a local pack):

```bash
# once published:
npm install @aiosbrain/aios-devtools

# meanwhile, from a checkout of this repo:
npm ci && npm pack
npm install ./aiosbrain-aios-devtools-<version>.tgz   # in the consuming project
```

Node `>=22 <23` is required (see `engines`).

### The `aios-devtools` bin

The install exposes one stable binary, `aios-devtools`, which dispatches the five
public commands to their implementation modules in-process — argv, cwd, environment,
stdio, exit codes, and signals are the command's own; the bin never reparses
command-specific flags:

```bash
aios-devtools --help                  # lists the five commands
aios-devtools build <plan-file|task> [branch] [options]
aios-devtools spec <spec-file> [options]
aios-devtools consolidate-findings [options]
aios-devtools ship <AIO-issue> [options]
aios-devtools roadmap-run [--label|--epic|--project ...] [options]
```

Programmatic consumers get the same surface via the package exports: the root
(`@aiosbrain/aios-devtools`) re-exports the five `cmdX(repo, args)` entry points plus
the relay-support functions (`runBuild`, `parseBuildArgs`, `evaluateSpec`, `loadRubric`,
`loadRecentDecisions`, `formatFindings`, `specEvalHints`); each command module is also
a subpath export (`@aiosbrain/aios-devtools/build`, `/spec-eval`,
`/consolidate-findings`, `/ship`, `/roadmap-run`) for lazy loading — this is the seam a
Workspace dispatch adapter delegates through.

**Toolkit seam requirement:** toolkit-dependent functionality needs an AIOS toolkit
checkout, located via `--toolkit-dir <path>` (per command) or `AIOS_TOOLKIT_DIR` in the
environment — see "The toolkit contract" below and
`docs/devtools-toolkit-contract.md`. Without one, seam-dependent paths fail with an
actionable locator error.

### Contributor flow (adjacent checkout)

For development, keep this repo and an `aios-workspace` checkout side by side and point
the seam at the workspace checkout:

```bash
git clone https://github.com/aiosbrain/aios-devtools
git clone https://github.com/aiosbrain/aios-workspace
cd aios-workspace && npm ci && cd ../aios-devtools
export AIOS_TOOLKIT_DIR="$(pwd)/../aios-workspace"
npm ci && npm test    # toolkit-dependent suites run instead of skipping
```

The adjacent checkout is a contributor convenience only — the normal release path uses
an installed, version-pinned distribution of this package (spec: Dispatch Contract).

## Provenance

Cut from **`aiosbrain/aios-workspace` @ `10099cd8b01bade40fd16f296fa523ef20b228c3`**
(AIO-594) via `git filter-repo` over the declared extraction + copy path manifests.
History for every travelling file is preserved (`git log --follow` depth matches core).
Copied-infrastructure files are temporary duplicates tracked as ongoing backlog under
**Linear AIO-663** — there is no convergence deadline (the repo owner dropped the
original 7-day deadline on 2026-08-03). See `docs/copy-ledger.md` for the tracked
convergence ledger (required terminal dispositions + status) and `NOTES.md` for the
cut-time notes.

## The toolkit contract

This repo is standalone for its own logic, but the stays-core engines (review-bugbot,
simplify, relay, spec-author) and core-owned content are reached **only** through the
toolkit-location seam (`scripts/toolkit-locate.mjs`). Toolkit-seam functionality
requires an AIOS toolkit checkout, located via (in precedence order):

1. `--toolkit-dir <path>` (CLI flag)
2. `AIOS_TOOLKIT_DIR=<path>` (environment)
3. the containing repo root, when this code runs inside an `aios-workspace` checkout

Without a toolkit, seam-dependent paths fail with an actionable locator error (never
an import crash), and toolkit-dependent tests **skip with a named reason**. The full
contract: `docs/devtools-toolkit-contract.md`.

```bash
export AIOS_TOOLKIT_DIR=/path/to/aios-workspace   # npm ci'd checkout
npm ci
npm test        # node --test over test/ — green with the toolkit; toolkit-dependent files skip without it
npm run lint    # node --check sweep over scripts/ + test/
```

## Entrypoint semantics

All six command modules load and run standalone (their full static import graph
resolves without a toolkit checkout):

| Entry | `--help` behavior |
|-------|-------------------|
| `scripts/ship.mjs` (`cmdShip`) | usage printed, exit 0 |
| `scripts/build.mjs` (`cmdBuild`) | usage printed, exit 0 |
| `scripts/roadmap-run.mjs` (`cmdRoadmapRun`) | usage printed, exit 0 |
| `scripts/spec-eval.mjs` (`cmdSpec`) | usage printed, exit 0 |
| `scripts/consolidate-findings.mjs` (`cmdConsolidateFindings`) | usage printed, exit 0 |
| `scripts/spec-publish.mjs` (`cmdSpecPublish`) | throws its own usage error (`SpecPublishError`) **by design** — there is no `--help` path in the function; behavior is byte-identical to the in-monorepo dispatch. Not an import crash. |

So: **5 entries exit 0 with usage; `cmdSpecPublish` exits with its designed usage
error** — parity with core, not six clean exits.

## Governance

Stamped by `aios repo-bootstrap` (worktree guard pack, file-size gate,
boundary gate, leak gate, CI skeleton) — see `ENGINEERING-CONSTITUTION.md`.
