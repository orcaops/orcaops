import type { EvaluatorVerdict } from './schemas/common.js';

/**
 * Info string identifying a verdict sentinel fence. A block opened with
 * ```` ```orcaops-verdict ```` and containing exactly one verdict token is
 * the evaluator's machine-readable answer.
 */
export const VERDICT_SENTINEL_INFO_STRING = 'orcaops-verdict';

const OPENING_FENCE = /^`{3,}[ \t]*orcaops-verdict[ \t]*$/;
const CLOSING_FENCE = /^`{3,}[ \t]*$/;

function tokenToVerdict(token: string): EvaluatorVerdict | null {
  if (token === 'PASS') return 'pass';
  if (token === 'VIOLATION') return 'violation';
  if (token === 'INFO') return 'info';
  return null;
}

/**
 * Scan for verdict sentinels and return the one named by the LAST
 * well-formed block. `null` when the response carries none.
 *
 * Last wins, not first. Prompts that document the sentinel necessarily
 * contain an example of it, and a model may echo that example before
 * committing to its own answer. The parser sees only the response body and
 * cannot tell an echoed example from an intent, so the final sentinel — the
 * one the model stopped on — is the only defensible reading.
 *
 * A block whose content is not exactly one verdict token is ignored rather
 * than treated as an error, as is an unterminated fence; both fall through
 * to the bare-line fallback in `parseMarkdownVerdict`.
 */
export function parseVerdictSentinel(body: string): EvaluatorVerdict | null {
  let last: EvaluatorVerdict | null = null;
  let collecting: string[] | null = null;

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (collecting === null) {
      if (OPENING_FENCE.test(trimmed)) collecting = [];
      continue;
    }
    if (CLOSING_FENCE.test(trimmed)) {
      const verdict = tokenToVerdict(collecting.join('\n').trim());
      if (verdict !== null) last = verdict;
      collecting = null;
      continue;
    }
    collecting.push(line);
  }

  return last;
}

/**
 * Markdown-mode verdict rule, in two tiers.
 *
 * 1. A ```` ```orcaops-verdict ```` sentinel block decides the verdict when
 *    one is present (last block wins).
 * 2. Otherwise, fall back to scanning every line for the LAST standalone
 *    PASS / VIOLATION / INFO. That tier is fence-blind by design — it
 *    predates the sentinel and keeps working for prompts that have not
 *    adopted one — so a bare verdict token inside an unrelated example block
 *    can decide the answer. Emitting a sentinel is what makes the response
 *    unambiguous.
 *
 * Returns `null` when neither tier finds a verdict.
 */
export function parseMarkdownVerdict(body: string): EvaluatorVerdict | null {
  const sentinel = parseVerdictSentinel(body);
  if (sentinel !== null) return sentinel;

  let last: EvaluatorVerdict | null = null;
  for (const line of body.split(/\r?\n/)) {
    const verdict = tokenToVerdict(line.trim());
    if (verdict !== null) last = verdict;
  }
  return last;
}
