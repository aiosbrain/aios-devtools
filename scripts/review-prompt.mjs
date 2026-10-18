// The code-review prompt. Lives apart from build.mjs (size-capped) so the tool-access wording
// can follow the reviewer's capability: a prompt-only model (e.g. deepseek) that is told to
// "run the tests yourself" answers with pseudo tool calls and never produces a verdict, which
// stalls the loop at BUILD_NONCONVERGENCE with nothing for the builder to fix.
import { MERGE_READY_TOKEN } from "./relay-core.mjs";

const TOOLED_NOTE =
  "Run the project's tests/validators yourself to gather evidence before you decide.";
const TOOLLESS_NOTE =
  "You have NO tools in this session: do not run commands and never emit tool calls or " +
  "function-call markup. The tool already ran the project's verification (build, tests, lint, " +
  "format) on this exact diff and only reaches you when it passed. Judge the diff below against " +
  "the plan and answer in plain text with your findings and, if ready, the verdict token.";

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
}) {
  const isLast = round >= maxRounds;
  const roundNote = isLast
    ? `**Final round (${round}/${maxRounds}). Do not raise new Low/Medium nits — but you MUST still withhold ${MERGE_READY_TOKEN} for any Critical/High finding or any unverified safety-critical surface.**`
    : `Round ${round} of ${maxRounds}.`;

  const evidenceNote = toolless ? TOOLLESS_NOTE : TOOLED_NOTE;

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
