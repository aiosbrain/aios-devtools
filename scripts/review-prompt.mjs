// The code-review prompt. Lives apart from build.mjs (size-capped) so the tool-access wording
// can follow the reviewer's capability: a prompt-only model (e.g. deepseek) that is told to
// "run the tests yourself" answers with pseudo tool calls and never produces a verdict, which
// stalls the loop at BUILD_NONCONVERGENCE with nothing for the builder to fix.
import { MERGE_READY_TOKEN } from "./relay-core.mjs";
import { parseModelRef } from "./model-providers.mjs";

/**
 * Whether the code-review call can actually run commands in the worktree. Only cursor (--force
 * --trust) and codex (read-only sandbox) can; deepseek/openrouter/opencode are plain chat
 * completions and claude runs with NO_TOOLS_ARGS. Keep in step with callPromptModel's switch in
 * model-call.mjs (a byte-copy of core's, so the predicate lives here).
 */
export function promptCallHasTools(model) {
  const { provider } = parseModelRef(model);
  return provider === "cursor" || provider === "codex";
}

const TOOLED_NOTE =
  "Run the project's tests/validators yourself to gather evidence before you decide.";
const toollessNote = (verifyCmd) =>
  "You have NO tools in this session: do not run commands and never emit tool calls or " +
  "function-call markup. " +
  (verifyCmd
    ? `The tool already ran \`${verifyCmd}\` on this exact diff and only reaches you when it passed. `
    : "No verification command was configured, so nothing has been run on this diff; say what you could not verify. ") +
  "Judge the diff below against the plan and answer in plain text with evidence-based findings " +
  "(file and line from the diff) and, only if it is truly ready, the verdict token. If the diff " +
  "below is truncated or replaced by a stat, you cannot inspect the change: do not emit the verdict " +
  "token, and list what you could not see.";

export function buildCodeReviewPrompt({
  skill,
  plan,
  diff,
  diffStat,
  logOneline,
  secretsResult,
  branch,
  round,
  maxRounds,
  builderSkillAudit = [],
  toolless = false,
  verifyCmd = null,
}) {
  const isLast = round >= maxRounds;
  const roundNote = isLast
    ? `**Final round (${round}/${maxRounds}). Do not raise new Low/Medium nits — but you MUST still withhold ${MERGE_READY_TOKEN} for any Critical/High finding or any unverified safety-critical surface.**`
    : `Round ${round} of ${maxRounds}.`;

  const evidenceNote = toolless ? toollessNote(verifyCmd) : TOOLED_NOTE;

  return [
    skill,
    "",
    `> ${roundNote}`,
    "",
    `You are reviewing a diff that is supposed to implement the plan below, on branch \`${branch}\` in an isolated worktree. ${evidenceNote}`,
    "",
    "## Original plan (what the diff must deliver)",
    "",
    plan,
    "",
    ...(builderSkillAudit.length
      ? [
          "## Builder skill conformance",
          "",
          ...builderSkillAudit.map(
            (entry) => `- ${entry.id} sha256=${entry.sha256} bytes=${entry.bytes}`
          ),
          "",
          "Verify the implementation honors the applicable hard constraints of these selected skills.",
          "",
        ]
      : []),
    "## Commits (base..HEAD)",
    "",
    logOneline || "(none)",
    "",
    "## git diff --stat",
    "",
    diffStat || "(empty)",
    "",
    "## git diff",
    "",
    diff,
    "",
    "## Pre-merge secrets scan (run by the tool)",
    "",
    secretsResult,
    "Note: the tool re-runs this scan fail-closed before any merge — a leak blocks the merge regardless of your verdict.",
    "",
    "---",
    `Review per your skill. Emit ${MERGE_READY_TOKEN} (alone on the very last line) ONLY when the code is truly ready to merge. Otherwise list the findings for the builder to fix.`,
  ].join("\n");
}
