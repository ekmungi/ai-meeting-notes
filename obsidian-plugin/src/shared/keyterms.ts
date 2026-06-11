// Assembles the keyterms_prompt list for AssemblyAI: contact names plus a
// user-configured term list, deduped (case-insensitive) and capped to the
// streaming API limits. Pure - no Obsidian or network access.

const MAX_KEYTERMS = 100;     // AssemblyAI streaming cap
const MAX_KEYTERM_LEN = 50;   // per-term char cap

/** Build the deduped, capped key-term list. extraTermsRaw is comma/newline separated. */
export function buildKeyTerms(contactNames: string[], extraTermsRaw: string): string[] {
  const extra = extraTermsRaw.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
  const merged = [...contactNames.map((n) => n.trim()).filter(Boolean), ...extra];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of merged) {
    if (term.length > MAX_KEYTERM_LEN) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}
