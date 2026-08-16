#!/usr/bin/env node
/**
 * check-copy-parity.mjs — makes `docs/copy-ledger.md` EXECUTABLE (AIO-663).
 *
 * The AIO-594 cut left 17 files duplicated between this repo and `aiosbrain/aios-workspace`.
 * The ledger recorded them and nothing enforced them, so the copies rotted independently and
 * silently: by 2026-08-16 six of the seventeen had drifted, three with real behavioural
 * consequences (a skill-routing hardening core got and this repo did not; spec-eval grading
 * against `gui/*` surfaces core deleted in AIO-612; the toolkit seam module disagreeing with
 * itself about its own argument contract, in the one module whose entire job is to define the
 * split's seam).
 *
 * None of that was caught by the existing `toolkit-drift` CI lane, and that is not a bug in that
 * lane: it runs THIS repo's tests against core `main`, which only fails when a divergence happens
 * to break a devtools test. A copy can drift arbitrarily far while every test stays green. This
 * check is the complementary one — it compares BYTES, row by row, and needs no test to notice.
 *
 * The row list is read from `docs/copy-ledger.md` rather than hard-coded here, so the ledger
 * cannot say one thing while CI checks another. Every row must declare a `Byte parity` mode:
 *
 *   - `enforced`            — the two copies must be byte-identical; any difference fails.
 *   - `exempt (<reason>)`   — the copies are intentionally NOT convergent; the reason is
 *                             mandatory and is printed on every run. Exempt rows are still
 *                             diffed and reported (advisory), so an intentional divergence
 *                             does not become an unexamined hiding place.
 *
 * Anything else — a missing column, an empty exemption reason, a ledger path that no longer
 * exists here — is a hard failure. A ledger that has stopped describing reality is exactly the
 * condition this check exists to detect.
 *
 * Usage:
 *   node scripts/check-copy-parity.mjs                 # core via AIOS_TOOLKIT_DIR/--toolkit-dir
 *   node scripts/check-copy-parity.mjs --core <dir>    # explicit core checkout
 *   node scripts/check-copy-parity.mjs --json          # machine-readable report on stdout
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { locateToolkit } from "./toolkit-locate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
export const LEDGER_PATH = path.join("docs", "copy-ledger.md");

/**
 * Parse the ledger's copy table into rows. Columns are resolved by HEADER NAME, not position,
 * so adding or reordering a column cannot silently repoint the check at the wrong cell.
 * @returns {{n: string, file: string, parity: "enforced"|"exempt", reason: string|null}[]}
 */
export function parseLedgerRows(markdown) {
  const lines = markdown.split("\n");
  const headerIdx = lines.findIndex((l) => /^\|\s*#\s*\|/.test(l));
  if (headerIdx === -1)
    throw new Error(`${LEDGER_PATH}: no copy table found (expected a '| # |' header row)`);
  const cells = (line) =>
    line
      .replace(/^\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  const header = cells(lines[headerIdx]).map((h) => h.toLowerCase());
  const col = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`${LEDGER_PATH}: copy table is missing a '${name}' column`);
    return i;
  };
  const iN = col("#");
  const iFile = col("temporary copy");
  const iParity = col("byte parity");

  const rows = [];
  for (const line of lines.slice(headerIdx + 2)) {
    if (!line.startsWith("|")) break;
    const c = cells(line);
    const file = (c[iFile] ?? "").replace(/`/g, "").trim();
    const parityCell = (c[iParity] ?? "").replace(/`/g, "").trim();
    if (!file) throw new Error(`${LEDGER_PATH}: row ${c[iN]} has no file path`);

    let parity;
    let reason = null;
    if (parityCell === "enforced") {
      parity = "enforced";
    } else {
      const m = /^exempt\s*\((.+)\)$/s.exec(parityCell);
      if (!m) {
        throw new Error(
          `${LEDGER_PATH}: row ${c[iN]} (${file}) declares byte parity '${parityCell || "(empty)"}'. ` +
            `Every row must be 'enforced' or 'exempt (<reason>)' — an undeclared row is how this ledger rotted before.`
        );
      }
      parity = "exempt";
      reason = m[1].trim();
      if (!reason)
        throw new Error(`${LEDGER_PATH}: row ${c[iN]} (${file}) is exempt with an empty reason`);
    }
    rows.push({ n: c[iN], file, parity, reason });
  }
  if (!rows.length) throw new Error(`${LEDGER_PATH}: copy table has no rows`);
  return rows;
}

function differingLineCount(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  const setB = new Set(lb);
  const setA = new Set(la);
  return la.filter((l) => !setB.has(l)).length + lb.filter((l) => !setA.has(l)).length;
}

/**
 * Byte-compare every ledger row against a core checkout.
 * @returns {{rows: object[], failures: string[]}}
 */
export function checkCopyParity({ repo = REPO_ROOT, core }) {
  const rows = parseLedgerRows(readFileSync(path.join(repo, LEDGER_PATH), "utf8"));
  const failures = [];
  const results = [];

  for (const row of rows) {
    const here = path.join(repo, row.file);
    const there = path.join(core, row.file);
    const hereExists = existsSync(here);
    const thereExists = existsSync(there);

    if (!hereExists) {
      failures.push(
        `row ${row.n} ${row.file}: listed in the ledger but MISSING from this repo. Either the copy was ` +
          `deleted (remove the row and record the disposition) or the path moved (fix the row).`
      );
      results.push({ ...row, status: "missing-here" });
      continue;
    }
    if (!thereExists) {
      // Core deleting its copy is a real, expected terminal state (devtools-owned) — but it must
      // be RECORDED, not inferred by a checker that shrugs and passes.
      failures.push(
        `row ${row.n} ${row.file}: no longer exists in core. If core deleted it, this row's ` +
          `disposition is settled ('devtools-owned') — say so in the ledger and mark parity exempt.`
      );
      results.push({ ...row, status: "missing-core" });
      continue;
    }

    const a = readFileSync(here);
    const b = readFileSync(there);
    const identical = a.equals(b);
    results.push({
      ...row,
      status: identical ? "identical" : "differs",
      differingLines: identical ? 0 : differingLineCount(a.toString("utf8"), b.toString("utf8")),
    });
    if (!identical && row.parity === "enforced") {
      failures.push(
        `row ${row.n} ${row.file}: BYTE DRIFT against core. Reconcile the two copies (or, if the ` +
          `divergence is deliberate, change the row to 'exempt (<reason>)' — with the reason).`
      );
    }
  }
  return { rows: results, failures };
}

function resolveCoreDir(argv) {
  const i = argv.indexOf("--core");
  if (i !== -1) {
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) throw new Error("--core requires a path argument");
    return path.resolve(value);
  }
  // Otherwise the repo's own seam contract decides what "a core checkout" means.
  return locateToolkit({ argv }).dir;
}

function main(argv) {
  const core = resolveCoreDir(argv);
  const { rows, failures } = checkCopyParity({ core });

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ core, rows, failures }, null, 2)}\n`);
  } else {
    console.log(`copy-parity: ${rows.length} ledger rows vs core checkout ${core}\n`);
    for (const r of rows) {
      const mark = r.status === "identical" ? "ok  " : r.parity === "exempt" ? "note" : "FAIL";
      const detail =
        r.status === "identical"
          ? "identical"
          : r.status.startsWith("missing")
            ? r.status
            : `differs (~${r.differingLines} lines)`;
      console.log(`  ${mark}  ${r.n.padStart(2)}  ${r.file} — ${detail}`);
      if (r.parity === "exempt") console.log(`          exempt: ${r.reason}`);
    }
    console.log("");
  }

  if (failures.length) {
    for (const f of failures) console.error(`::error::copy-parity: ${f}`);
    console.error(
      `\ncopy-parity FAILED: ${failures.length} row(s). See docs/copy-ledger.md — the table is the ` +
        `source of truth for this check, so fixing the code and fixing the row are the same job.`
    );
    return 1;
  }
  console.log("copy-parity: every enforced row is byte-identical to core.");
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`::error::copy-parity: ${err.message}`);
    process.exit(1);
  }
}
