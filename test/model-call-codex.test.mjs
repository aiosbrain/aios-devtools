import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { callAgentModel, callPromptModel } from "../scripts/model-call.mjs";

test("Codex agent and prompt routes preserve args and isolate prompt reviews", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "devtools-codex-"));
  const bin = path.join(dir, "bin");
  const worktree = path.join(dir, "worktree");
  const argsFile = path.join(dir, "args.json");
  const envFile = path.join(dir, "env.json");
  await mkdir(bin, { recursive: true });
  await mkdir(worktree);
  const shim = path.join(bin, "codex");
  writeFileSync(
    shim,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));\nwriteFileSync(${JSON.stringify(envFile)}, JSON.stringify({ hasOpenaiKey: 'OPENAI_API_KEY' in process.env }));\nconst i = args.indexOf('--output-last-message');\nwriteFileSync(args[i + 1], 'Codex final message\\n');\n`
  );
  chmodSync(shim, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = [bin, oldPath].join(path.delimiter);

  try {
    const callerEnv = { ...process.env, OPENAI_API_KEY: "caller-api-key" };
    const agentResult = await callAgentModel({
      model: "codex:gpt-5.6-sol",
      prompt: "implement",
      timeoutMs: 30_000,
      opts: { cwd: worktree, extraArgs: ["--json"], env: callerEnv },
    });
    let args = JSON.parse(readFileSync(argsFile, "utf8"));
    assert.equal(agentResult, "Codex final message");
    assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
    assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-sol");
    assert.equal(args[args.indexOf("--cd") + 1], worktree);
    assert.equal(callerEnv.OPENAI_API_KEY, "caller-api-key");
    // A subscription-billed Codex run must never inherit a metered API key.
    assert.equal(JSON.parse(readFileSync(envFile, "utf8")).hasOpenaiKey, false);

    const promptResult = await callPromptModel({
      model: "codex:gpt-5.6-sol",
      prompt: "review",
      timeoutMs: 30_000,
      opts: { cwd: worktree, env: callerEnv },
    });
    args = JSON.parse(readFileSync(argsFile, "utf8"));
    assert.equal(promptResult, "Codex final message");
    assert.deepEqual(
      args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2),
      ["--sandbox", "read-only"]
    );
    assert.equal(JSON.parse(readFileSync(envFile, "utf8")).hasOpenaiKey, false);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
