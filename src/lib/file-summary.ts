// Deterministic, high-confidence file summaries for the Read offload.
//
// The PreToolUse offload only helps if the summary it serves instead of the full
// file is trustworthy. Mubit's *semantic* "what is file X" answers proved too
// low-confidence to ever fire (see the live A/B bench). So for Reads we instead
// derive a STRUCTURAL summary straight from the current file bytes: the leading
// doc comment + the top-level/exported signatures + simple constant values +
// (for class-heavy files) method signatures. It's exact (confidence 1.0), always
// fresh (built from current content), and answers the "where does X live / what
// does this file contain / name the functions" questions that drive most reads —
// while keeping the file's bulk out of the agent's context.
//
// Pure: operates on content, not paths (path is just for the header label).

const MAX_LINE = 140; // cap a single signature line
const MAX_DECLS = 60; // cap how many declarations we list

// Top-level declaration (indent 0–2): the strong "what's in this file" signal.
const TOP_LEVEL_DECL =
  /^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\b|class\b|interface\b|type\b|enum\b|const\b|let\b|var\b|namespace\b|module\b)/;

// A method signature one level inside a class (indent 2–4). Excludes control flow.
const METHOD_SIG = /^(public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+|\*\s*)*[A-Za-z_$][\w$]*\s*[(<]/;
const CONTROL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "else", "do", "try", "throw", "await", "yield", "case", "new",
]);

function tidy(line: string): string {
  // Drop trailing block-open and bodies so we keep just the signature.
  let s = line.trim().replace(/\s*\{\s*$/, "").replace(/\s*=>\s*\{?\s*$/, " =>").trim();
  if (s.length > MAX_LINE) {
    s = `${s.slice(0, MAX_LINE - 1)}…`;
  }
  return s;
}

function leadingDocComment(lines: string[]): string | null {
  const out: string[] = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (t.length === 0 && out.length === 0) {
      continue; // skip leading blanks
    }
    if (t.startsWith("//")) {
      out.push(t.replace(/^\/\/+\s?/, ""));
    } else if (t.startsWith("/*") || t.startsWith("*") || t.endsWith("*/")) {
      const cleaned = t.replace(/^\/\*+\s?/, "").replace(/\*+\/$/, "").replace(/^\*\s?/, "").trim();
      if (cleaned) out.push(cleaned);
      if (t.endsWith("*/") && !t.startsWith("/*")) break;
    } else {
      break; // first non-comment line ends the header block
    }
    if (out.length >= 6) break;
  }
  const text = out.join(" ").trim();
  return text.length > 0 ? text.slice(0, 320) : null;
}

const methodName = (line: string): string => line.trim().match(/^[\w$ ]*?([A-Za-z_$][\w$]*)\s*[(<]/)?.[1] ?? "";

/**
 * Build a compact structural summary of a source file, clamped to ~maxTokens
 * (≈4 chars/token). Returns "" only for empty input.
 */
export function summarizeFileForOffload(filePath: string, content: string, maxTokens = 400): string {
  const lines = content.split("\n");
  const decls: string[] = [];
  for (const raw of lines) {
    if (decls.length >= MAX_DECLS) break;
    const indent = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t.length === 0) continue;
    if (indent === 0 && TOP_LEVEL_DECL.test(t)) {
      decls.push(tidy(t));
    } else if (indent >= 2 && indent <= 4 && METHOD_SIG.test(t) && !CONTROL_KEYWORDS.has(methodName(t))) {
      // class member / method signature
      const sig = tidy(t);
      if (sig.length > 0 && !sig.startsWith("//")) decls.push(`  ${sig}`);
    }
  }

  const parts: string[] = [`${filePath} — ${lines.length} lines`];
  const doc = leadingDocComment(lines);
  if (doc) {
    parts.push(`Purpose: ${doc}`);
  }
  if (decls.length > 0) {
    parts.push("Declarations / outline:");
    parts.push(...decls.map((d) => (d.startsWith("  ") ? d : `- ${d}`)));
  } else {
    // Non-code (md/json/etc.): fall back to a short head preview.
    const head = lines.filter((l) => l.trim().length > 0).slice(0, 15);
    parts.push("Preview:", ...head.map((l) => l.trim().slice(0, MAX_LINE)));
  }

  let summary = parts.join("\n");
  const maxChars = Math.max(0, Math.trunc(maxTokens)) * 4;
  if (summary.length > maxChars) {
    const marker = "\n…(summary truncated)";
    summary = `${summary.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
  }
  return summary;
}
