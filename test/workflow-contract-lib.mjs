/**
 * Workflow-contract helpers, shared by `test/ci-security.test.mjs` and by the regeneration
 * path below.
 *
 * WHY THESE LIVE TOGETHER. The contract these back is an ALLOWLIST: instead of scanning a
 * workflow for forbidden idioms, it asserts the exact set of lines that are allowed to be
 * there. Shell has unbounded ways to discard a non-zero exit (`|| true`, `|| :`, `; true`,
 * `if ! cmd; then :; fi`, a trailing `exit 0`, a `trap 'exit 0' EXIT`, ...) and no
 * enumeration of them is ever finished — asserting the one command allowed to run catches
 * all of them by construction.
 *
 * An allowlist is only as strong as its SCOPE, and that is where the first version of this
 * contract failed. It allowlisted two job blocks, so everything outside those two slices
 * was unasserted. Adversarial review (AIO-699, at e5b2053) demonstrated two ways through:
 *
 *   - a WORKFLOW-LEVEL default, `defaults.run.shell: bash -c 'bash "$0" || true' {0}`,
 *     which GitHub applies to every `run` step in every job. It swallowed a script exiting
 *     23 in both allowlisted jobs, and changed nothing inside either job block.
 *   - `|| true` appended to both confidentiality leak scans in the `gates` job, which no
 *     allowlist covered at all — leaving the security gate able to report green after
 *     finding confidential material.
 *
 * Both passed the full suite. The fix is not another forbidden-substring rule for
 * `defaults:` — that is the same blacklist mistake one level up, over a space (GitHub's
 * workflow syntax) that this repo does not control and cannot exhaust. The fix is to widen
 * the allowlist to the WHOLE FILE, so any behaviorally meaningful line anywhere in the
 * workflow — top-level keys included — must appear in the frozen contract.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CI_CONTRACT_PATH = path.join(repoRoot, "test", "fixtures", "ci-workflow-contract.txt");

/** Each `- ` step of a workflow, as text, from its dash line up to the next one. */
export function workflowSteps(workflow) {
  const lines = workflow.split("\n");
  const starts = lines.flatMap((line, index) => (/^      - /.test(line) ? [index] : []));
  return starts.map((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length).join("\n")
  );
}

// Top-level job blocks are keyed by a two-space-indented `<name>:` line; the block runs
// until the next such line (or EOF), minus any trailing blank/comment lines that are
// actually the lead-in commentary for the *next* job. Used to scope assertions to one job.
export function jobBlock(workflow, jobName) {
  const lines = workflow.split("\n");
  const startIndex = lines.findIndex((line) => line === `  ${jobName}:`);
  if (startIndex === -1) return undefined;
  const nextTopLevel = lines
    .slice(startIndex + 1)
    .findIndex((line) => /^  [A-Za-z0-9_-]+:$/.test(line));
  let endIndex = nextTopLevel === -1 ? lines.length : startIndex + 1 + nextTopLevel;
  while (endIndex > startIndex + 1 && /^[ \t]*(#.*)?$/.test(lines[endIndex - 1])) endIndex -= 1;
  return lines.slice(startIndex, endIndex).join("\n");
}

// The behaviorally meaningful lines of a workflow (or of one job block): blank lines and
// pure YAML-level comment lines are dropped; everything else is preserved in order, so a key
// reorder or a name/runs-on swap still shows up as a diff.
//
// Comment leniency stops at the boundary of a `run: |`/`run: >` block scalar. GitHub Actions
// expands `${{ ... }}` expressions into the script text *before* the shell ever parses it, so
// a `#`-prefixed line inside `run:` is not inert the way a YAML comment is — an expression
// built from untrusted input (e.g. `${{ github.event.pull_request.body }}`) can contain a
// newline that breaks out of the "comment" and executes. Every line inside an active run
// block is therefore treated as significant, comment-shaped or not; only lines outside any
// run block get comment/blank leniency.
//
// The block-scalar header match is deliberately narrow (`|`/`>` with an optional chomping
// indicator). YAML also accepts an explicit indentation indicator — `|2`, `|2-`, `|-2`,
// `|+2`, `|2+`, `>2` — which this regex does NOT recognise as a block start. That is
// tolerable ONLY because the contract covers the whole file: a header rewritten to any of
// those spellings is itself a changed line, so the comparison fails on the header before the
// leniency question ever arises. Verified against PyYAML and actionlint for all six
// spellings. Narrow the file's scope again and this becomes a real hole.
//
// LINES ARE COMPARED VERBATIM. There is no trailing-whitespace strip, and "blank" and
// "comment" are judged with ASCII space and tab only — never `\s` or `.trim()`, both of which
// are Unicode-wide. Adversarial review defeated the Unicode-wide version at 040e60b: appending
// U+1680 OGHAM SPACE MARK to an inline `run:` command was accepted by both PyYAML and
// actionlint and CHANGED THE EXECUTED ARGV — bash does not treat U+1680 as a separator, so npm
// received it as part of the argument and failed — yet the contract stayed green, because
// `/\s+$/` had trimmed the character away before the comparison ever happened. Any line that
// gains a character, whitespace-looking or not, is now a changed line that must be re-frozen
// deliberately.
const ASCII_BLANK = /^[ \t]*$/;
const ASCII_COMMENT = /^[ \t]*#/;

export function significantLines(block) {
  const lines = block.split("\n");
  const result = [];
  let runBlockIndent = null; // set while inside a `run: |`/`run: >` block scalar
  for (const line of lines) {
    const indent = line.match(/^[ \t]*/)[0].length;

    if (runBlockIndent !== null) {
      if (ASCII_BLANK.test(line)) continue; // blank lines don't end a YAML block scalar
      if (indent > runBlockIndent) {
        result.push(line); // inside the run body — always significant, comments included
        continue;
      }
      runBlockIndent = null; // dedented back out of the block scalar
    }

    const runStart = line.match(/^([ \t]*)run:[ \t]*[|>][+-]?[ \t]*$/);
    if (runStart) {
      result.push(line);
      runBlockIndent = runStart[1].length;
      continue;
    }

    if (ASCII_BLANK.test(line) || ASCII_COMMENT.test(line)) continue; // YAML-level comment
    result.push(line);
  }
  return result;
}

/** The frozen contract as an array of lines. */
export function readCiContract() {
  return readFileSync(CI_CONTRACT_PATH, "utf8").replace(/\n$/, "").split("\n");
}

// Regeneration: `node test/workflow-contract-lib.mjs > test/fixtures/ci-workflow-contract.txt`
// Read the failing diff first and satisfy yourself every changed line is intended — this
// file is the only thing standing between a swallowed exit status and a green check.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  process.stdout.write(`${significantLines(workflow).join("\n")}\n`);
}
