import {
  EvaluatorFindingsBlockSchema,
  FINDINGS_BLOCK_SCHEMA,
  type FindingsRead,
} from './schemas/finding.js';

/**
 * Info string identifying the optional findings block a markdown-mode LLM
 * evaluator may emit. Its content is JSON carrying the same `schema` literal
 * discipline as the result envelope, so the protocol has one negotiation rule
 * and one set of finding schemas.
 *
 * JSON rather than a line grammar for a second reason: inside JSON no line
 * can be a bare PASS / VIOLATION / INFO token, because every string is quoted
 * and every embedded newline is escaped. The block therefore cannot disturb
 * `parseMarkdownVerdict`, whose second tier is fence-blind.
 */
export const FINDINGS_BLOCK_INFO_STRING = 'orcaops-findings';

/**
 * Longest block content this parser will accumulate. A size bound refuses
 * here rather than truncating, unlike the bounds on a finding's own fields:
 * half a JSON document does not parse, so there is nothing to keep.
 */
export const MAX_FINDINGS_BLOCK_CHARS = 256 * 1024;

/** CommonMark: four columns of leading whitespace make a line literal code. */
const MAX_FENCE_INDENT_COLUMNS = 3;

const FENCE_LINE = /^(`{3,}|~{3,})(.*)$/;
const BACKTICK_LINE = /^`{3,}/;

interface OpenFence {
  char: string;
  length: number;
  isFindings: boolean;
  lines: string[];
  size: number;
}

/** A fence closes only on its own character, at least as long, and bare. */
function closesFence(trimmed: string, open: OpenFence): boolean {
  const match = FENCE_LINE.exec(trimmed);
  if (match === null) return false;
  if (match[1][0] !== open.char || match[1].length < open.length) return false;
  return match[2].trim().length === 0;
}

function indentColumns(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += 4;
    else break;
    if (columns > MAX_FENCE_INDENT_COLUMNS) return columns;
  }
  return columns;
}

/**
 * Read the one optional findings block out of a markdown response.
 *
 * Only TOP-LEVEL, unindented fences are recognised. While a fence is open an
 * inner fence line is content, and only a closing fence at least as long ends
 * it; a fence indented four or more columns is literal code, which is how
 * CommonMark renders a documented example. Both together are what let a
 * prompt show the block without a model's echo of it becoming a second one.
 *
 * Exactly one block. Last-block-wins — the rule the verdict sentinel uses —
 * would adopt an echoed example placed last as real findings, and would lose
 * half of an honest response split across two blocks without saying so; a
 * second block makes the findings unreadable instead, which keeps the verdict
 * and loses nothing silently.
 *
 * A response cut off mid-block is unreadable rather than absent: a truncated
 * response is precisely the case where "produced no finding" must not read as
 * "found nothing".
 */
export function parseFindingsBlock(body: string): FindingsRead {
  let open: OpenFence | null = null;
  let content: string | null = null;

  // Lone `\r` is a line ending on its own: a response that used one would
  // otherwise arrive as a single line and every fence in it would vanish.
  for (const line of body.split(/\r\n|\r|\n/)) {
    const indented = indentColumns(line) > MAX_FENCE_INDENT_COLUMNS;
    const trimmed = line.trim();

    if (open !== null) {
      if (!indented && closesFence(trimmed, open)) {
        if (open.isFindings) {
          if (content !== null) {
            return unreadable(
              `response carries more than one top-level \`${FINDINGS_BLOCK_INFO_STRING}\` block; exactly one is allowed`
            );
          }
          content = open.lines.join('\n');
        }
        open = null;
        continue;
      }
      if (open.isFindings) {
        // Bound while accumulating, so an unbounded block is refused before
        // it is held in one string.
        open.size += line.length + 1;
        if (open.size > MAX_FINDINGS_BLOCK_CHARS) {
          return unreadable(
            `\`${FINDINGS_BLOCK_INFO_STRING}\` block exceeds ${MAX_FINDINGS_BLOCK_CHARS} characters`
          );
        }
        open.lines.push(line);
      }
      continue;
    }

    if (indented) continue;

    const fence = FENCE_LINE.exec(trimmed);
    if (fence === null) continue;
    const char = fence[1][0];

    // CommonMark forbids a backtick in a backtick fence's info string, so a
    // line carrying one opens nothing. Reporting it as absent would lose the
    // findings in silence, which is the one outcome this parser never
    // produces.
    if (char === '`' && fence[2].includes('`')) {
      if (BACKTICK_LINE.test(trimmed) && trimmed.includes(FINDINGS_BLOCK_INFO_STRING)) {
        return unreadable(
          `fence info string must be exactly \`${FINDINGS_BLOCK_INFO_STRING}\` with no backtick`
        );
      }
      continue;
    }

    const info = fence[2].trim();
    if (info.length > 0 && info.split(/\s+/)[0] === FINDINGS_BLOCK_INFO_STRING) {
      if (char === '~') {
        return unreadable(
          `a \`${FINDINGS_BLOCK_INFO_STRING}\` block must use a backtick fence, not a tilde fence`
        );
      }
      if (info !== FINDINGS_BLOCK_INFO_STRING) {
        return unreadable(
          `fence info string must be exactly \`${FINDINGS_BLOCK_INFO_STRING}\`, not \`${bound(info, 120)}\``
        );
      }
      open = { char, length: fence[1].length, isFindings: true, lines: [], size: 0 };
      continue;
    }
    open = { char, length: fence[1].length, isFindings: false, lines: [], size: 0 };
  }

  if (open !== null && open.isFindings) {
    return unreadable(`\`${FINDINGS_BLOCK_INFO_STRING}\` block was opened and never closed`);
  }
  if (content === null) return { status: 'absent' };
  return readFindingsBlockContent(content);
}

function readFindingsBlockContent(content: string): FindingsRead {
  if (content.length > MAX_FINDINGS_BLOCK_CHARS) {
    return unreadable(
      `\`${FINDINGS_BLOCK_INFO_STRING}\` block exceeds ${MAX_FINDINGS_BLOCK_CHARS} characters`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return unreadable(
      `\`${FINDINGS_BLOCK_INFO_STRING}\` block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // `JSON.parse` keeps the last of two identical keys and discards the first
  // without a word, so `{"findings":[a],"findings":[b]}` would read as a
  // clean `b`. Half a producer's answer must never disappear that way.
  if (hasDuplicateJsonKeys(content)) {
    return unreadable(
      `\`${FINDINGS_BLOCK_INFO_STRING}\` block repeats an object key, so what it means cannot be decided`
    );
  }

  // The literal is read before the strict parse, as it is for the envelope,
  // so an unsupported version is named instead of reported as a bad literal.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return unreadable(
      `\`${FINDINGS_BLOCK_INFO_STRING}\` block must be a JSON object carrying \`schema\` and \`findings\``
    );
  }
  const declared = (parsed as Record<string, unknown>).schema;
  if (typeof declared !== 'string' || declared.length === 0) {
    return unreadable(
      `\`${FINDINGS_BLOCK_INFO_STRING}\` block must declare \`schema: "${FINDINGS_BLOCK_SCHEMA}"\``
    );
  }
  if (declared !== FINDINGS_BLOCK_SCHEMA) {
    return unreadable(
      `unsupported findings block schema "${bound(declared, 120)}"; this release reads "${FINDINGS_BLOCK_SCHEMA}"`
    );
  }

  const block = EvaluatorFindingsBlockSchema.safeParse(parsed);
  if (!block.success) {
    const issue = block.error.issues[0];
    return unreadable(
      `\`${FINDINGS_BLOCK_INFO_STRING}\` block is invalid — ${issue.path.join('.') || '<root>'}: ${issue.message}`
    );
  }
  return { status: 'ok', findings: block.data.findings };
}

/**
 * Whether any object in a JSON document names the same key twice.
 *
 * Runs only on text `JSON.parse` already accepted, so it can assume the
 * document is well formed and needs to track nothing but string literals and
 * container nesting.
 */
function hasDuplicateJsonKeys(text: string): boolean {
  const stack: { isObject: boolean; keys: Set<string> }[] = [];
  let expectKey = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char === '{') {
      stack.push({ isObject: true, keys: new Set() });
      expectKey = true;
      index += 1;
    } else if (char === '[') {
      stack.push({ isObject: false, keys: new Set() });
      expectKey = false;
      index += 1;
    } else if (char === '}' || char === ']') {
      stack.pop();
      expectKey = false;
      index += 1;
    } else if (char === ',') {
      expectKey = stack[stack.length - 1]?.isObject === true;
      index += 1;
    } else if (char === ':') {
      expectKey = false;
      index += 1;
    } else if (char === '"') {
      const end = endOfJsonString(text, index);
      if (expectKey) {
        const top = stack[stack.length - 1];
        // Decoded, not compared as written: `"\u0066indings"` and `"findings"` are one key to
        // `JSON.parse`, which would keep the second and drop the first just the same.
        const key = JSON.parse(text.slice(index, end)) as string;
        if (top !== undefined) {
          if (top.keys.has(key)) return true;
          top.keys.add(key);
        }
        expectKey = false;
      }
      index = end;
    } else {
      index += 1;
    }
  }
  return false;
}

/** Index just past the closing quote of the string literal starting at `start`. */
function endOfJsonString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  return text.length;
}

function unreadable(reason: string): FindingsRead {
  return { status: 'unreadable', reason };
}

function bound(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
