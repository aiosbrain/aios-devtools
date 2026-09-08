// Assemble the stable legacy prompt. The reviewer body carries the output format, severity
// vocabulary, and BUGBOT_CLEAR rule; this appends every gathered input including the PR diff.
export function buildConsolidatePrompt(reviewerPrompt, inputs = {}) {
  const {
    pr,
    issue,
    checks,
    prDiff,
    issueComments,
    inlineComments,
    reviews,
    localBugbotMarkdown,
    gptMarkdown,
  } = inputs;
  const asJson = (v) => JSON.stringify(v ?? [], null, 2);
  let checkLines = "(no CI check data)";
  if (checks?.checks?.length) {
    checkLines = checks.checks
      .map((x) => `[${x.bucket || x.state || x.conclusion || "?"}] ${x.name}`)
      .join("\n");
  } else if (checks?.ciRed) {
    checkLines = "(CI is red — see the raw board)";
  }
  return [
    reviewerPrompt.trim(),
    "",
    "---",
    "",
    `You are CONSOLIDATING every independent review of PR #${pr ?? "?"} (${issue ?? "?"}) into ONE finding list.`,
    "Instructions:",
    "- Dedupe findings that describe the same issue across sources.",
    "- Tag every merged finding with its origin: `(source: Local Bugbot|CodeRabbit|GPT-5.5)`.",
    "- Tag any AIOS-rule / plan-conformance finding with `(plan-conformance)`.",
    "- Rank findings by severity (Critical > High > Medium > Low).",
    "- Emit EXACTLY the `## Output format` structure above, using the `[severity] file:line — …` bracket form.",
    "- If (and only if) there are no Critical or High findings, end with `BUGBOT_CLEAR` alone on the last line.",
    "",
    "## CI checks",
    "",
    checkLines,
    "",
    "## PR diff (base..head)",
    "",
    prDiff || "(no diff)",
    "",
    "## Local Bugbot review",
    "",
    localBugbotMarkdown || "(missing — caller must fail before this prompt)",
    "",
    "## Current-head CodeRabbit issue comments",
    "",
    asJson(issueComments),
    "",
    "## Current-head CodeRabbit inline diff comments",
    "",
    asJson(inlineComments),
    "",
    "## Current-head CodeRabbit submitted reviews",
    "",
    asJson(reviews),
    "",
    "## GPT-5.5 review",
    "",
    gptMarkdown || "(none provided)",
  ].join("\n");
}
