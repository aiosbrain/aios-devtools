// Pack/install verification for @aiosbrain/aios-devtools (AIO-594 PR A):
// `npm pack` → assert the tarball honors the files allowlist → install the tarball
// into a fresh temp project → run the installed `aios-devtools` bin.
// Needs registry access for the two runtime dependencies; CI runs this as its own
// "pack and install verification" job.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_COMMANDS = ["build", "spec", "consolidate-findings", "ship", "roadmap-run"];

test("npm pack → install into a temp project → installed bin runs", { timeout: 300_000 }, () => {
  const packDest = mkdtempSync(path.join(tmpdir(), "aios-devtools-pack-"));
  const installDir = mkdtempSync(path.join(tmpdir(), "aios-devtools-install-"));
  try {
    // ── pack ──
    const packJson = execFileSync("npm", ["pack", "--json", "--pack-destination", packDest], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const [info] = JSON.parse(packJson);
    const tarball = path.join(packDest, info.filename);
    const shipped = info.files.map((f) => f.path);

    // Runtime surface must be in the tarball…
    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "scripts/cli.mjs",
      "scripts/index.mjs",
      "scripts/build.mjs",
      "scripts/spec-eval.mjs",
      "scripts/consolidate-findings.mjs",
      "scripts/ship.mjs",
      "scripts/roadmap-run.mjs",
      "docs/devtools-toolkit-contract.md",
    ]) {
      assert.ok(shipped.includes(required), `tarball must contain ${required}`);
    }
    // …and the repo-only trees must not be.
    for (const banned of ["test/", "hooks/", ".harness/", ".claude/", ".github/"]) {
      assert.ok(
        !shipped.some((p) => p.startsWith(banned)),
        `tarball must not contain ${banned}`
      );
    }

    // ── install into a fresh temp project ──
    execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
      cwd: installDir,
      encoding: "utf8",
    });

    // ── the installed bin works ──
    const bin = path.join(installDir, "node_modules", ".bin", "aios-devtools");
    const help = execFileSync(bin, ["--help"], { cwd: installDir, encoding: "utf8" });
    for (const name of PUBLIC_COMMANDS) {
      assert.match(help, new RegExp(`^  ${name} `, "m"), `installed --help must list ${name}`);
    }

    // …and the installed package resolves programmatically (root + a subpath export).
    const resolved = execFileSync(
      process.execPath,
      [
        "-e",
        'import("@aiosbrain/aios-devtools").then((m) => import("@aiosbrain/aios-devtools/build").then((b) => console.log(typeof m.cmdShip, typeof b.parseBuildArgs)))',
      ],
      { cwd: installDir, encoding: "utf8" }
    );
    assert.equal(resolved.trim(), "function function");
  } finally {
    rmSync(packDest, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
});
