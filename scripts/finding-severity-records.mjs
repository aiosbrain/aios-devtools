// Devtools-owned per-record adapter over the byte-pinned canonical severity matcher.
// It gives observation inventory counts without creating a second severity dialect.
import { hasFindingsAtOrAbove } from "./severity.mjs";

const SEVERITIES = ["Critical", "High", "Medium", "Low"];
const GPT_RECORD = /^\s*-\s*`(Critical|High|Medium|Low)`\s+`[^`\n]+`/i;

function classifyCanonicalLine(line) {
  return SEVERITIES.find((severity) => hasFindingsAtOrAbove(line, severity)) ?? null;
}

/** Return at most one canonical severity classification for each source line. */
export function extractFindingSeverityRecords(text, { dialect = "canonical" } = {}) {
  if (!new Set(["canonical", "gpt"]).has(dialect)) throw new Error(`unsupported finding dialect: ${dialect}`);
  const records = [];
  for (const [lineIndex, line] of String(text ?? "").split("\n").entries()) {
    let candidate = line;
    if (dialect === "gpt") {
      const match = line.match(GPT_RECORD);
      if (!match) continue;
      candidate = `- ${match[1]}: finding`;
    }
    const severity = classifyCanonicalLine(candidate);
    if (severity) records.push({ line: lineIndex + 1, severity });
  }
  return records;
}
