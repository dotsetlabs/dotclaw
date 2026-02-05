/**
 * Extract JSON object from text that may contain surrounding content.
 * Handles responses where JSON is wrapped in markdown or explanatory text.
 * Uses balanced-brace walking to avoid matching across separate JSON objects.
 */
export function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const start = trimmed.indexOf('{');
  if (start < 0) return null;

  // Walk from the first '{' tracking brace depth
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }

  // Unbalanced braces — fall back to first/last brace heuristic
  const end = trimmed.lastIndexOf('}');
  if (end > start) return trimmed.slice(start, end + 1);
  return null;
}
