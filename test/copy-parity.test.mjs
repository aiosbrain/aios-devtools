// test/copy-parity.test.mjs — guards the ledger-driven parity check (AIO-663).
//
// The byte comparison itself needs a core checkout and runs as its own CI job. What runs in EVERY
// lane, toolkit or not, is the part that can rot on its own: the ledger table must stay parseable,
// every row must declare a parity mode, every exemption must carry a reason, and every listed path
// must still exist here. A ledger that stops describing reality disables the check silently, which
// is the exact failure this whole exercise exists to remove.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseLedgerRows,
  checkCopyParity,
  REPO_ROOT,
  LEDGER_PATH,
} from "../scripts/check-copy-parity.mjs";

const ledger = readFileSync(path.join(REPO_ROOT, LEDGER_PATH), "utf8");

test("the ledger table parses and every row declares a parity mode", () => {
  const rows = parseLedgerRows(ledger);
  assert.equal(
    rows.length,
    19,
    "17 AIO-594 cut copies + 2 AIO-1072 rows (distribution-root classifier enforced, " +
      "same-path cli.mjs seam exempt); changing the count is a ledger decision"
  );
  for (const row of rows) {
    assert.ok(["enforced", "exempt"].includes(row.parity), `row ${row.n}: ${row.parity}`);
    if (row.parity === "exempt") {
      assert.ok(row.reason && row.reason.length > 20, `row ${row.n} needs a real exemption reason`);
    }
  }
});

test("every ledger path still exists in this repo", () => {
  for (const row of parseLedgerRows(ledger)) {
    assert.ok(
      existsSync(path.join(REPO_ROOT, row.file)),
      `${row.file} (row ${row.n}) is listed but missing`
    );
  }
});

test("a row with no parity mode is a hard parse failure, not a silent skip", () => {
  const table = [
    "| # | Temporary copy | Required disposition | Status | Byte parity | Linear issue |",
    "|---|---|---|---|---|---|",
    "| 1 | `scripts/a.mjs` | foundation export | unresolved |  | AIO-663 |",
  ].join("\n");
  assert.throws(() => parseLedgerRows(table), /must be 'enforced' or 'exempt/);
});

test("an exemption with an empty reason is rejected", () => {
  const table = [
    "| # | Temporary copy | Required disposition | Status | Byte parity | Linear issue |",
    "|---|---|---|---|---|---|",
    "| 1 | `scripts/a.mjs` | foundation export | unresolved | exempt () | AIO-663 |",
  ].join("\n");
  assert.throws(() => parseLedgerRows(table), /must be 'enforced' or 'exempt|empty reason/);
});

test("byte drift on an enforced row fails; the same drift on an exempt row is advisory", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "copy-parity-repo-"));
  const core = mkdtempSync(path.join(tmpdir(), "copy-parity-core-"));
  try {
    for (const dir of [repo, core]) mkdirSync(path.join(dir, "scripts"), { recursive: true });
    mkdirSync(path.join(repo, "docs"), { recursive: true });
    writeFileSync(path.join(repo, "scripts", "same.mjs"), "export const x = 1;\n");
    writeFileSync(path.join(core, "scripts", "same.mjs"), "export const x = 1;\n");
    writeFileSync(path.join(repo, "scripts", "drift.mjs"), "export const y = 1;\n");
    writeFileSync(path.join(core, "scripts", "drift.mjs"), "export const y = 2;\n");

    const write = (parity) =>
      writeFileSync(
        path.join(repo, LEDGER_PATH),
        [
          "| # | Temporary copy | Required disposition | Status | Byte parity | Linear issue |",
          "|---|---|---|---|---|---|",
          "| 1 | `scripts/same.mjs` | foundation export | unresolved | enforced | AIO-663 |",
          `| 2 | \`scripts/drift.mjs\` | foundation export | unresolved | ${parity} | AIO-663 |`,
          "",
        ].join("\n")
      );

    write("enforced");
    const strict = checkCopyParity({ repo, core });
    assert.equal(strict.failures.length, 1);
    assert.match(strict.failures[0], /row 2 scripts\/drift\.mjs: BYTE DRIFT/);

    write("exempt (deliberately divergent for a documented reason)");
    const lenient = checkCopyParity({ repo, core });
    assert.deepEqual(lenient.failures, []);
    // Still reported, never hidden.
    assert.equal(lenient.rows[1].status, "differs");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(core, { recursive: true, force: true });
  }
});

test("a ledger row whose file is gone on either side fails loudly", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "copy-parity-repo-"));
  const core = mkdtempSync(path.join(tmpdir(), "copy-parity-core-"));
  try {
    mkdirSync(path.join(repo, "docs"), { recursive: true });
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    writeFileSync(path.join(repo, "scripts", "here-only.mjs"), "export const z = 1;\n");
    writeFileSync(
      path.join(repo, LEDGER_PATH),
      [
        "| # | Temporary copy | Required disposition | Status | Byte parity | Linear issue |",
        "|---|---|---|---|---|---|",
        "| 1 | `scripts/here-only.mjs` | foundation export | unresolved | enforced | AIO-663 |",
        "| 2 | `scripts/nowhere.mjs` | foundation export | unresolved | enforced | AIO-663 |",
        "",
      ].join("\n")
    );
    const { failures } = checkCopyParity({ repo, core });
    assert.equal(failures.length, 2);
    assert.match(failures[0], /no longer exists in core/);
    assert.match(failures[1], /MISSING from this repo/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(core, { recursive: true, force: true });
  }
});
