# Copy ledger — AIO-594 temporary copy convergence

The 17 temporary copies carried into this repo by the AIO-594 cut (source:
`aiosbrain/aios-workspace` @ `10099cd8b01bade40fd16f296fa523ef20b228c3`; see `NOTES.md`
for the cut-time notes). Table copied from the AIO-594 devtools canonicalization and
removal specification ("Temporary Copy Convergence").

Every item must receive one terminal disposition: foundation export, Devtools ownership
with core deletion, intentional core ownership with Devtools consumption through the
toolkit seam, or an explicitly approved new deadline.

| # | Temporary copy | Required disposition | Status | Linear issue |
|---|----------------|----------------------|--------|--------------|
| 1 | `scripts/relay-core.mjs` | foundation export or Devtools-owned | unresolved | TBD |
| 2 | `scripts/model-call.mjs` | foundation model-dispatch export | unresolved | TBD |
| 3 | `scripts/loop-models.mjs` | foundation model-dispatch export | unresolved | TBD |
| 4 | `scripts/model-providers.mjs` | foundation model-dispatch export | unresolved | TBD |
| 5 | `scripts/pr.mjs` | foundation GitHub-plumbing export | unresolved | TBD |
| 6 | `scripts/skill-context.mjs` | foundation skill-context export | unresolved | TBD |
| 7 | `scripts/cli-common.mjs` | foundation CLI-plumbing export | unresolved | TBD |
| 8 | `scripts/ui/output-context.mjs` | foundation CLI-plumbing export | unresolved | TBD |
| 9 | `scripts/severity.mjs` | foundation severity export | unresolved | TBD |
| 10 | `scripts/verify-cmd.mjs` | foundation verification-command export | unresolved | TBD |
| 11 | `scripts/spec-checks.mjs` | foundation deterministic-spec export | unresolved | TBD |
| 12 | `scripts/spec-checks/deterministic.mjs` | move with spec-checks export | unresolved | TBD |
| 13 | `scripts/spec-checks/rubric.mjs` | move with spec-checks; replace module-relative rubric fallback with toolkit resolution | unresolved | TBD |
| 14 | `scripts/spec-checks/spec-text.mjs` | move with spec-checks export | unresolved | TBD |
| 15 | `scripts/scan-file.mjs` | foundation scan export | unresolved | TBD |
| 16 | `scripts/toolkit-locate.mjs` | foundation locator export or separately versioned identical contract implementation | unresolved | TBD |
| 17 | `docs/devtools-toolkit-contract.md` | Devtools canonical; Workspace retains a short consumer contract/link | unresolved | TBD |

Governance-stamp files (`scripts/check-file-size.mjs`, `scripts/check-boundaries.mjs`,
`scripts/git-files.mjs`, `scripts/leak-gate.sh`, `validation/agent-readiness-lib.mjs`,
`.harness/**`) remain managed by `aios repo-bootstrap`; they are re-synced by re-running
the stamp and are **not** part of this copy ledger.

Status values: `unresolved` → `in-progress` → one of `foundation-export` /
`devtools-owned` / `core-owned-via-seam` / `re-deadlined (<date, approval ref>)`.
Fill the Linear issue column as owning issues are created; each row's terminal
disposition needs byte/behavior parity evidence where applicable (spec: Acceptance
Criteria).
