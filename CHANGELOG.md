# Changelog

All notable changes to `@aiosbrain/aios-devtools`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-08-20

### Fixed

- **`aios spec eval` now works in a rubric-less repo** (AIO-686, copy-ledger row 13).
  The toolkit-rubric fallback in `scripts/spec-checks/rubric.mjs` was module-relative,
  so a standalone devtools install resolved
  `<devtools>/.claude/rubrics/spec-readiness.md` — a file that does not exist and must
  not, because the rubric is core-owned. Any repo without its own
  `.claude/rubrics/` (the Team Brain, or any bare repo) died with
  `error: rubric not found`, exit 4. The fallback now resolves through the toolkit
  contract (`getToolkit()`), lazily, so the explicit `--rubric` and repo-local paths
  are unaffected and still never require a toolkit. Precedence is unchanged:
  `--rubric` → repo-local → toolkit.

  Requires `@aiosbrain/aios` with the matching core-side change, which supplies
  `AIOS_TOOLKIT_DIR` to out-of-tree devtools modules.

### Changed

- **License: MIT → AGPL-3.0-only.** The manifest was relicensed upstream without a
  version bump, so published `0.2.1` carries MIT metadata while its source is AGPL.
  `0.3.0` is the first release whose registry metadata matches its source. The
  lockfile's own `license` field, which still recorded MIT, is corrected in the same
  change.

### Added

- **Publishing now requires an immutable tag.** `publish-npm.yml` was
  `workflow_dispatch`-only with no ref guard, so a stable version could be published
  from any branch — the exact trap core already guards against. It now requires
  dispatch from `refs/tags/v<version>`, matching the published version exactly, and
  refuses prereleases on the stable channel.
- This changelog. `0.2.0` and `0.2.1` were published without one.

[0.3.0]: https://github.com/aiosbrain/aios-devtools/releases/tag/v0.3.0
