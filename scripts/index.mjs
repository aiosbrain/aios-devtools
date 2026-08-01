// scripts/index.mjs — the package-root export of @aiosbrain/aios-devtools (AIO-594 PR A).
//
// The programmatic delegation surface: the five public command entry points, plus the
// relay-support functions aios-workspace's scripts/relay.mjs currently imports from
// build.mjs and spec-eval.mjs — so a future Workspace dispatch adapter can delegate
// through this package instead of in-tree copies. All five modules load standalone
// (their full static import graph resolves without a toolkit checkout; toolkit-seam
// functionality is resolved at run time — docs/devtools-toolkit-contract.md).
//
// Subpath exports for lazy loading: @aiosbrain/aios-devtools/build, /spec-eval,
// /consolidate-findings, /ship, /roadmap-run (see package.json "exports").

// Command entry points — each takes (repo, args) exactly like the in-monorepo dispatch.
export { cmdBuild } from "./build.mjs";
export { cmdSpec } from "./spec-eval.mjs";
export { cmdConsolidateFindings } from "./consolidate-findings.mjs";
export { cmdShip } from "./ship.mjs";
export { cmdRoadmapRun } from "./roadmap-run.mjs";

// Relay-support surface — the exact names aios-workspace scripts/relay.mjs imports today.
export { runBuild, parseBuildArgs } from "./build.mjs";
export {
  evaluateSpec,
  loadRubric,
  loadRecentDecisions,
  formatFindings,
  specEvalHints,
} from "./spec-eval.mjs";
