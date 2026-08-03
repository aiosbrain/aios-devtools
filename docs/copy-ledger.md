# Copy ledger — AIO-594 temporary copy convergence

The 17 temporary copies carried into this repo by the AIO-594 cut (source:
`aiosbrain/aios-workspace` @ `10099cd8b01bade40fd16f296fa523ef20b228c3`; see `NOTES.md`
for the cut-time notes). Table copied from the AIO-594 devtools canonicalization and
removal specification ("Temporary Copy Convergence").

**There is no convergence deadline.** The original 7-day deadline from the 2026-07-31
cut push was dropped by explicit decision of the repo owner (John Ellison) on
2026-08-03. Convergence is now tracked as ordinary backlog under **Linear AIO-663**,
with no expiry. Every item must still receive one terminal disposition: foundation
export, Devtools ownership with core deletion, or intentional core ownership with
Devtools consumption through the toolkit seam.

| # | Temporary copy | Required disposition | Status | Linear issue |
|---|----------------|----------------------|--------|--------------|
| 1 | `scripts/relay-core.mjs` | foundation export or Devtools-owned | in-progress | AIO-663 (entangled with AIO-684) |
| 2 | `scripts/model-call.mjs` | foundation model-dispatch export | in-progress | AIO-663 |
| 3 | `scripts/loop-models.mjs` | foundation model-dispatch export | in-progress | AIO-663 |
| 4 | `scripts/model-providers.mjs` | foundation model-dispatch export | in-progress | AIO-663 |
| 5 | `scripts/pr.mjs` | foundation GitHub-plumbing export | in-progress | AIO-663 |
| 6 | `scripts/skill-context.mjs` | foundation skill-context export | in-progress | AIO-663 |
| 7 | `scripts/cli-common.mjs` | foundation CLI-plumbing export | in-progress | AIO-663 |
| 8 | `scripts/ui/output-context.mjs` | foundation CLI-plumbing export | in-progress | AIO-663 |
| 9 | `scripts/severity.mjs` | foundation severity export | in-progress | AIO-663 |
| 10 | `scripts/verify-cmd.mjs` | foundation verification-command export | in-progress | AIO-663 |
| 11 | `scripts/spec-checks.mjs` | foundation deterministic-spec export | in-progress | AIO-663 |
| 12 | `scripts/spec-checks/deterministic.mjs` | move with spec-checks export | in-progress | AIO-663 |
| 13 | `scripts/spec-checks/rubric.mjs` | move with spec-checks; replace module-relative rubric fallback with toolkit resolution | in-progress | AIO-686 |
| 14 | `scripts/spec-checks/spec-text.mjs` | move with spec-checks export | in-progress | AIO-663 |
| 15 | `scripts/scan-file.mjs` | foundation scan export | in-progress | AIO-663 |
| 16 | `scripts/toolkit-locate.mjs` | foundation locator export or separately versioned identical contract implementation | in-progress | AIO-663 |
| 17 | `docs/devtools-toolkit-contract.md` | Devtools canonical; Workspace retains a short consumer contract/link | in-progress | AIO-663 |

Governance-stamp files (`scripts/check-file-size.mjs`, `scripts/check-boundaries.mjs`,
`scripts/git-files.mjs`, `scripts/leak-gate.sh`, `validation/agent-readiness-lib.mjs`,
`.harness/**`) remain managed by `aios repo-bootstrap`; they are re-synced by re-running
the stamp and are **not** part of this copy ledger.

Status values: `unresolved` → `in-progress` → one of `foundation-export` /
`devtools-owned` / `core-owned-via-seam`. The prior `re-deadlined (<date, approval
ref>)` status is **retired**: there is no deadline left to redeclare against, so this
status no longer applies and should not be used. Fill the Linear issue column as owning
issues are created; each row's terminal disposition needs byte/behavior parity evidence
where applicable (spec: Acceptance Criteria).
