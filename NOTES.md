# NOTES — AIO-594 cut ledger

Cut source: **`aiosbrain/aios-workspace` @ `10099cd8b01bade40fd16f296fa523ef20b228c3`**
(origin/main, post-seam PR #511). Staged 2026-07-31.

## Copy ledger — temporary duplicates (7-day convergence deadline)

Every file below is a **copy** of the core file at source SHA `10099cd8`; core keeps its
own. Deadline: **7 days from the initial push of this history to
`aiosbrain/aios-devtools`** — by then each file must either move behind a
`@aiosbrain/foundation` export, be adopted as devtools-owned (deleted in core), or be
re-declared with a new deadline in the cut follow-up issue.

| File | Planned convergence path |
|------|--------------------------|
| `scripts/relay-core.mjs` | foundation export (relay plumbing hub) |
| `scripts/model-call.mjs` | foundation export (model-dispatch hub) |
| `scripts/loop-models.mjs` | foundation export (model-dispatch hub) |
| `scripts/model-providers.mjs` | foundation export (model-dispatch hub) |
| `scripts/pr.mjs` | foundation export (gh plumbing) |
| `scripts/skill-context.mjs` | foundation export (skill-suite loader) |
| `scripts/cli-common.mjs` | foundation export (CLI plumbing) |
| `scripts/ui/output-context.mjs` | foundation export (CLI plumbing) |
| `scripts/severity.mjs` | foundation export (severity ranking; contract-declared leaf) |
| `scripts/verify-cmd.mjs` | foundation export (SHIP_VERIFY_CMD leaf) |
| `scripts/spec-checks.mjs` | foundation export (deterministic spec layer barrel; core's spec-author consumes it too) |
| `scripts/spec-checks/deterministic.mjs` | with the barrel |
| `scripts/spec-checks/rubric.mjs` | with the barrel — **see convergence item 1 below** |
| `scripts/spec-checks/spec-text.mjs` | with the barrel |
| `scripts/scan-file.mjs` | foundation export (post-#510 core leaf; core's promote.mjs re-exports) |
| `scripts/toolkit-locate.mjs` | foundation export (seam impl; core keeps its own — run-gui.mjs imports it) |
| `docs/devtools-toolkit-contract.md` | contract doc — core copy stays canonical until the cut ships, then this copy becomes canonical for the devtools set |

Governance-stamp files (`scripts/check-file-size.mjs`, `check-boundaries.mjs`,
`git-files.mjs`, `leak-gate.sh`, `validation/agent-readiness-lib.mjs`, `.harness/**`) are
**managed by `aios repo-bootstrap`** (see `.aios-bootstrap-version`) — re-synced by re-running
the stamp, not subject to the 7-day copy deadline.

## Convergence items (recorded, not fixed here)

1. **`scripts/spec-checks/rubric.mjs` toolkit fallback is module-relative.**
   `TOOLKIT_RUBRIC_PATH` resolves `../../.claude/rubrics/spec-readiness.md` from the module
   file — loadable in-monorepo, but in this repo it points at an absent path. Standalone
   callers grading a repo that vendors no rubric must pass `--rubric` (or the target repo
   vendors one). Fix belongs in the shared copy (route through the toolkit-locate seam)
   when it converges into foundation; the devtools copy stays byte-parity until then.
   `test/spec-eval-rubric.test.mjs` asserts only the fallback's path shape for this reason.

## Test placement (AIO-594 cut decisions)

- `test/fix-ladder.test.mjs`, `test/review-timeout-retry.test.mjs` — **stayed in core**
  (they statically test the stays-core review engine); removed from the cut manifest.
- `test/devtools-seam.test.mjs` — travelled **split**: the check-boundaries drift-guard
  subtest stays core (reads core's `scripts/check-boundaries.mjs` + `boundaries.json`);
  the core-side file is untouched core content.
- `test/toolkit-locate.test.mjs` — travelled **split**: the two containing-repo subtests
  (assert the containing repo IS a toolkit) stay core; core-side file untouched.
- Workspace-shaped tests resolve core-owned content (rubric, skill suite, `validation/`)
  from an AIOS toolkit checkout at runtime via `AIOS_TOOLKIT_DIR` and **skip with a named
  reason** when absent (`test/fixture-workspace.mjs`) — no vendored core trees.
- `test/fixtures/spec-eval/strong-spec.md` integration points were repointed to
  devtools-resident files (previously named core-staying `scripts/relay.mjs` and the core
  rubric path).

## Entrypoint semantics

See README.md: 5 command entries exit 0 with usage under `--help`; `cmdSpecPublish`
throws its designed usage error (`SpecPublishError`) — byte-identical to in-monorepo
behavior, not an import crash. Recorded as **5 clean + 1 parity-expected usage error**.
