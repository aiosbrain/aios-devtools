import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("packed install exposes the exact schema, pin, and reviewed registry", () => {
  const packDir = mkdtempSync(path.join(tmpdir(), "finding-pack-"));
  const installDir = mkdtempSync(path.join(tmpdir(), "finding-install-"));
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: ROOT, encoding: "utf8" }));
  const tarball = path.join(packDir, packed[0].filename);
  writeFileSync(path.join(installDir, "package.json"), '{"type":"module"}\n');
  execFileSync("npm", ["install", "--ignore-scripts", tarball], { cwd: installDir, stdio: "pipe" });
  const packageRoot = path.join(installDir, "node_modules", "@aiosbrain", "aios-devtools");
  const expected = ["finding-observations.v1.schema.json", "finding-observations.v1.sha256", "finding-observations.registry.v1.json"];
  for (const name of expected) assert.equal(readFileSync(path.join(packageRoot, "contracts", name), "utf8").length > 0, true);
  const schema = readFileSync(path.join(packageRoot, "contracts", expected[0]));
  assert.equal(createHash("sha256").update(schema).digest("hex"), "a51f360769ab26440287891867447baf6e3df93073df6f0d7febc1f3c10322b2");
});
