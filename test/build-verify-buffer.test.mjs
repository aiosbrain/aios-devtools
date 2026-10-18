import { test } from "node:test";
import assert from "node:assert/strict";
import { runVerification } from "../scripts/build.mjs";

test("runVerification passes a command that prints more than 1 MiB and exits 0", () => {
  const cmd = `node -e "process.stdout.write('x'.repeat(3 * 1024 * 1024))"`;
  const v = runVerification(process.cwd(), cmd);
  assert.equal(v.ok, true);
  assert.equal(v.output.length, 3000);
});

test("runVerification still fails a command that exits non-zero", () => {
  const v = runVerification(process.cwd(), `node -e "process.stderr.write('boom'); process.exit(1)"`);
  assert.equal(v.ok, false);
  assert.match(v.output, /boom/);
});
