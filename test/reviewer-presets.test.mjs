import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveLoopModels } from "../scripts/loop-models.mjs";
import { resolveReviewerPreset } from "../scripts/model-providers.mjs";

test("reviewer presets resolve safely and support spec_eval Codex", async () => {
  assert.equal(resolveReviewerPreset("constructor"), null);
  assert.equal(resolveReviewerPreset("__proto__"), null);

  const repo = await mkdtemp(path.join(tmpdir(), "devtools-loop-models-"));
  await mkdir(path.join(repo, ".aios"));
  await writeFile(
    path.join(repo, ".aios", "loop-models.yaml"),
    "spec_eval_preset: codex-subscription\n"
  );
  const resolved = resolveLoopModels({ repo });
  assert.equal(resolved.spec_eval.model, "codex:gpt-5.6-terra");
});

test("unsupported Codex tiers fail during model resolution", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "devtools-loop-models-"));
  await mkdir(path.join(repo, ".aios"));
  await writeFile(
    path.join(repo, ".aios", "loop-models.yaml"),
    "code_review_model: codex:gpt-9.9\n"
  );
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import { resolveLoopModels } from './scripts/loop-models.mjs'; resolveLoopModels({ repo: ${JSON.stringify(repo)} });`],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unavailable Codex tier/);
});
