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

Dropping the deadline removed the timebox, **not the obligation**. Every row below is
still `unresolved` — it is de-timeboxed backlog, not work in flight. A row advances to
`in-progress` only when someone is actually executing it, so that a status read of this
table cannot overstate how much is underway.

**AIO-663 is the umbrella tracker** for the ledger as a whole. Individual rows may carry
a more specific issue that executes that row's work: row 13 is owned by **AIO-686**, and
row 1 is entangled with **AIO-684** (the CLI marker tokens defined in `relay-core.mjs`).
Reporting on AIO-663 alone therefore understates the ledger — read the Linear column.

## This table is executed, not just read (2026-08-16)

`scripts/check-copy-parity.mjs` **parses this table** and byte-compares every row against a
core `aios-workspace` checkout; the `copy parity (core main)` CI job runs it against core
`main` on every PR. The **Byte parity** column is that check's input:

- `enforced` — the two copies must be byte-identical. Any difference fails CI.
- `exempt (<reason>)` — the copies are deliberately not convergent. The reason is mandatory
  and is printed on every run. Exempt rows are still diffed and reported (advisory), so an
  intentional divergence never becomes an unexamined hiding place.

A row with no parity mode, an empty exemption reason, or a path that no longer exists is a
hard failure — a ledger that has stopped describing reality is the condition the check exists
to catch. Editing the table therefore changes what CI enforces; keep them one edit.

**Why this was needed.** The ledger tracked 17 copies for two weeks with nothing enforcing
them. A 2026-08-16 audit byte-diffed all 17 and found six drifted, three behaviourally:
row 6 never received core's boundary-aware skill-sigil hardening (a skill id inside a URL or
path mis-routed); row 12 still graded specs against the `gui/client` and `gui/server` surfaces
core deleted in AIO-612 on 2026-08-04, and **spec-eval runs from this repo**, so every eval
was scoring surfaces that no longer existed in the repo being graded; row 16 — the module that
*defines* the split's seam — disagreed with itself across the two repos about both its
validation rule and its exported API. The existing `toolkit-drift` lane passed through all six,
correctly: it runs this repo's tests against core `main`, so it only fires when a divergence
happens to break a test. Bytes needed a byte check.

**Byte convergence is not a terminal disposition.** Rows 2, 4, 6, 12 and 16 are now
byte-identical to core and machine-enforced, but they are still *duplicates* — ownership
(foundation export / devtools-owned / core-owned-via-seam) remains open, so their Status stays
`unresolved`. The two columns answer different questions: Status is "who will own this", Byte
parity is "can it rot while we decide".

| # | Temporary copy | Required disposition | Status | Byte parity | Linear issue |
|---|----------------|----------------------|--------|-------------|--------------|
| 1 | `scripts/relay-core.mjs` | foundation export or Devtools-owned | unresolved | enforced | AIO-663 (entangled with AIO-684) |
| 2 | `scripts/model-call.mjs` | foundation model-dispatch export | unresolved | enforced | AIO-663 |
| 3 | `scripts/loop-models.mjs` | foundation model-dispatch export | unresolved | exempt (core imports `./flat-yaml.mjs`; this repo imports `@aiosbrain/foundation/internal/flat-yaml`, which core does not yet depend on. Resolves only when the module moves into `@aiosbrain/foundation` — until then the copies also carry unreconciled reviewer-preset error-message deltas, visible in this check's advisory diff) | AIO-663 |
| 4 | `scripts/model-providers.mjs` | foundation model-dispatch export | unresolved | enforced | AIO-663 |
| 5 | `scripts/pr.mjs` | foundation GitHub-plumbing export | unresolved | enforced | AIO-663 |
| 6 | `scripts/skill-context.mjs` | foundation skill-context export | unresolved | enforced | AIO-663 |
| 7 | `scripts/cli-common.mjs` | foundation CLI-plumbing export | unresolved | enforced | AIO-663 |
| 8 | `scripts/ui/output-context.mjs` | foundation CLI-plumbing export | unresolved | enforced | AIO-663 |
| 9 | `scripts/severity.mjs` | foundation severity export | unresolved | enforced | AIO-663 |
| 10 | `scripts/verify-cmd.mjs` | foundation verification-command export | unresolved | enforced | AIO-663 |
| 11 | `scripts/spec-checks.mjs` | foundation deterministic-spec export | unresolved | enforced | AIO-663 |
| 12 | `scripts/spec-checks/deterministic.mjs` | move with spec-checks export | unresolved | enforced | AIO-663 |
| 13 | `scripts/spec-checks/rubric.mjs` | move with spec-checks; ~~replace module-relative rubric fallback with toolkit resolution~~ — **toolkit resolution landed (AIO-686)**: the fallback now goes through `getToolkit()`, so a rubric-less repo grades against the toolkit's own rubric instead of exiting 4. The row stays `unresolved` because the MODULE is still a copy — only the fallback was fixed, not the duplication | unresolved | enforced | AIO-686 |
| 14 | `scripts/spec-checks/spec-text.mjs` | move with spec-checks export | unresolved | enforced | AIO-663 |
| 15 | `scripts/scan-file.mjs` | foundation scan export | unresolved | enforced | AIO-663 |
| 16 | `scripts/toolkit-locate.mjs` | foundation locator export or separately versioned identical contract implementation | unresolved | enforced | AIO-663 |
| 17 | `docs/devtools-toolkit-contract.md` | Devtools canonical; Workspace retains a short consumer contract/link | unresolved | exempt (this repo is the canonical owner by disposition; core keeps a shorter consumer-side contract. The two are deliberately different documents, not copies) | AIO-663 |

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
