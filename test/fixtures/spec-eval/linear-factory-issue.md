---
spec_gate: block
type: issue-spec
---

# Agentic Linear factory: aios-issue-template + spec-eval + workstream ops

## What / why

Unify Fred Jonsson's agentic Linear factory patterns (triage → parallel batches → session closeout) with AIOS spec-eval (SR1–SR17) so **Linear issue bodies are agent contracts** that pass `aios spec eval` before build. Today the Build Paradigm defines pick-up-able issues but there is no single scaffold, no `spec init`, and `linear.mjs` cannot template or patch descriptions safely.

## Outcomes

- One canonical template (`aios-issue-template.md`) used for Linear descriptions and local specs
- `aios spec init`, `linear.mjs template|create --template|patch-desc` shipped with tests
- `workstream-update` skill emits 3–5 batch prompts from the AIO board
- Factory workflow documented in `aios-linear` SKILL + `linear-factory` rule
- This issue body passes `aios spec eval` before pickup

## Interface / integration points

- `docs/agentic-ergonomics/aios-issue-template.md` — canonical scaffold
- `docs/agentic-ergonomics/build-paradigm.md` — §1 pointer to template
- `scripts/spec-eval.mjs` — SR5 Outcomes, acceptance subsections, `spec init`
- `.claude/rubrics/spec-readiness.md` — template mapping appendix
- `scaffold/.claude/skills/aios-linear/linear.mjs` — template, patch-desc, get --full + comments
- `scaffold/.claude/skills/workstream-update/workstream-update.mjs` — batch planner
- `scaffold/.claude/rules/linear-factory.md` — triage, hierarchy, closeout conventions
- `test/template-spec-readiness.test.mjs`, `test/linear-template.test.mjs` — contract tests

## Dependencies

Depends on: none (toolkit PR in `aios-workspace`; dogfood copy in `john-workspace` skills)

## Scope

**In:** template + spec-eval sync + linear CLI + workstream skill + rule + tests + this Linear issue.

**Deferred:** custom Linear MCP server; harness hooks blocking close on unchecked boxes; brain pm-sync template injection; a client team.

## Implementation approach

Land all template/rubric/spec-eval changes in one `aios-workspace` PR. Sync scaffold skills to `john-workspace` for dogfood. Use `eval_tier: deterministic` only for mechanical doc-only slices.

## Acceptance criteria

### Automated

- `node --test test/template-spec-readiness.test.mjs` exits 0 in `aios-workspace`
- `node --test test/linear-template.test.mjs` exits 0 in `aios-workspace`
- `node --test test/spec-eval-deterministic.test.mjs` exits 0 in `aios-workspace`
- `node scripts/aios.mjs spec init /tmp/smoke-issue.md --title smoke --repo .` writes scaffold in `aios-workspace`
- `node scaffold/.claude/skills/aios-linear/linear.mjs template aios` prints template when run from `aios-workspace` with `LINEAR_API_KEY` set

### Manual

- `workstream-update.mjs` run against live AIO board produces a readable batch doc with 3+ workstreams when backlog has candidates
- `patch-desc` with SEARCH/REPLACE block updates only the targeted description section

### Visual

- (none)

## Build-with

Build-with: deterministic docs/CLI — implement directly without model build loop.

## Tier safety

No brain/sync surfaces touched. Toolkit changes only; `john-workspace` receives skill copies after upstream merge.
