// test/fixture-workspace.mjs — devtools-owned staging helper for workspace-shaped tests
// (AIO-594 cut). Core-owned content (the spec-readiness rubric, the delivery skill suite)
// is resolved from an AIOS toolkit checkout at RUNTIME via AIOS_TOOLKIT_DIR — the GUI
// repo's F-fix pattern: explicit skip-when-absent, never vendored into this repo
// (docs/devtools-toolkit-contract.md). Nothing here expands the production boundary:
// runtime commands read the TARGET repo (a real workspace); only tests stage content.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEVTOOLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RUBRIC_REL = path.join(".claude", "rubrics", "spec-readiness.md");

/** The AIOS toolkit checkout, or null. Env-only on purpose: tests must be deterministic
 * about their content source (the runtime seam's flag/containing-repo fallbacks are
 * exercised by test/toolkit-locate.test.mjs, not here). */
export function toolkitDir() {
  const dir = process.env.AIOS_TOOLKIT_DIR;
  if (!dir) return null;
  if (!existsSync(path.join(dir, "scripts", "aios.mjs"))) return null;
  if (!existsSync(path.join(dir, "scaffold"))) return null;
  return dir;
}

/** Named skip reason for toolkit-dependent tests. */
export function toolkitSkip(what) {
  return (
    `requires core-owned ${what} from an AIOS toolkit checkout — ` +
    `set AIOS_TOOLKIT_DIR (docs/devtools-toolkit-contract.md)`
  );
}

/** Absolute path of a toolkit file, or null when no toolkit / file absent. */
export function toolkitFile(rel) {
  const dir = toolkitDir();
  if (!dir) return null;
  const p = path.join(dir, rel);
  return existsSync(p) ? p : null;
}

/**
 * Stage a minimal spec workspace in a temp dir:
 *   - core-owned: .claude/rubrics/spec-readiness.md + .claude/skill-suite.json and the
 *     skill files it references (copied from the toolkit at runtime — never wholesale
 *     trees, never committed);
 *   - devtools-owned: the files the spec fixtures name as integration points (SR3/SR16
 *     real-path resolution), copied from THIS repo.
 * Returns { dir, skip }: dir=null + a named skip reason when no toolkit is available.
 */
export function stageSpecWorkspace() {
  const toolkit = toolkitDir();
  if (!toolkit) return { dir: null, skip: toolkitSkip("spec rubric + delivery skill suite") };

  const dir = mkdtempSync(path.join(tmpdir(), "devtools-spec-ws-"));

  // core-owned content, resolved at runtime
  mkdirSync(path.join(dir, ".claude", "rubrics"), { recursive: true });
  cpSync(path.join(toolkit, RUBRIC_REL), path.join(dir, RUBRIC_REL));
  const suiteSrc = path.join(toolkit, ".claude", "skill-suite.json");
  cpSync(suiteSrc, path.join(dir, ".claude", "skill-suite.json"));
  const schemaSrc = path.join(toolkit, ".claude", "skill-suite.schema.json");
  if (existsSync(schemaSrc)) {
    cpSync(schemaSrc, path.join(dir, ".claude", "skill-suite.schema.json"));
  }
  const suite = JSON.parse(readFileSync(suiteSrc, "utf8"));
  for (const skill of suite.skills ?? []) {
    if (!skill.path) continue;
    const src = path.join(toolkit, ".claude", "skills", skill.path);
    if (!existsSync(src)) continue;
    const dst = path.join(dir, ".claude", "skills", skill.path);
    mkdirSync(path.dirname(dst), { recursive: true });
    cpSync(src, dst);
  }

  // devtools-owned integration-point targets named by the spec fixtures
  for (const rel of [
    path.join("scripts", "spec-eval.mjs"),
    path.join("scripts", "spec-publish.mjs"),
    path.join("scripts", "spec-checks", "rubric.mjs"),
  ]) {
    const src = path.join(DEVTOOLS_ROOT, rel);
    if (!existsSync(src)) continue;
    const dst = path.join(dir, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    cpSync(src, dst);
  }

  return { dir, skip: false };
}
