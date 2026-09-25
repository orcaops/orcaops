export interface JsonRepairEdit {
  /** UTF-16 offset in the unchanged original body, as used by String.slice. */
  offset: number;
  removed: string;
  inserted: string;
}

export interface JsonRepair {
  originalBody: string;
  edits: JsonRepairEdit[];
}

interface Token {
  text: string;
  offset: number;
}

const MAX_EDITS = 4;
const MAX_CANDIDATES = 256;
const MAX_TOKENS = 32_768;

export function readJsonAnswer(body: string): { body: string; jsonRepair?: JsonRepair } | null {
  try {
    JSON.parse(body);
    return { body };
  } catch {
    const rescued = rescueJson(body);
    return rescued === null ? null : { body: rescued.body, jsonRepair: rescued.repair };
  }
}

/** Punctuation only: never complete a truncated value or choose between different parses. */
export function rescueJson(body: string): { body: string; repair: JsonRepair } | null {
  if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) return null;
  let source = body;
  let base = 0;
  const wrapper: JsonRepairEdit[] = [];
  const fence = /^(\s*```(?:json)?[ \t]*\r?\n)([\s\S]*?)(\r?\n```\s*)$/i.exec(body);
  if (fence) {
    source = fence[2]!;
    base = fence[1]!.length;
    wrapper.push(
      { offset: 0, removed: fence[1]!, inserted: '' },
      { offset: base + source.length, removed: fence[3]!, inserted: '' }
    );
  }
  const tokens = tokenize(source, base);
  if (tokens === null || tokens.length === 0) return null;
  const excess = { '}': 0, ']': 0 };
  for (const token of tokens) {
    if (token.text === '{') excess['}']--;
    if (token.text === '[') excess[']']--;
    if (token.text === '}') excess['}']++;
    if (token.text === ']') excess[']']++;
  }
  if (excess['}'] < 0 || excess[']'] < 0 || excess['}'] + excess[']'] > MAX_EDITS) return null;

  // Only surplus closers in repeated runs or at the tail are eligible; opening
  // delimiters and every value token must survive unchanged.
  const isCloser = (text: string | undefined) => text === '}' || text === ']';
  let tail = tokens.length;
  while (tail > 0 && isCloser(tokens[tail - 1]!.text)) tail--;
  const candidates = tokens.flatMap((token, index) =>
    isCloser(token.text) &&
    (index >= tail ||
      tokens[index - 1]?.text === token.text ||
      tokens[index + 1]?.text === token.text)
      ? [index]
      : []
  );
  let searched = 0;
  let exhausted = false;
  let ambiguous = false;
  let result: { body: string; repair: JsonRepair; identity: string } | null = null;
  const visit = (start: number, removed: Set<number>, braces: number, brackets: number): void => {
    if (exhausted || ambiguous) return;
    if (++searched > MAX_CANDIDATES) {
      exhausted = true;
      return;
    }
    if (braces === 0 && brackets === 0) {
      const remaining = tokens.filter((_, index) => !removed.has(index));
      const edits = [...removed].map((index) => ({
        offset: tokens[index]!.offset,
        removed: tokens[index]!.text,
        inserted: '',
      }));
      const commas = repairCommas(remaining, MAX_EDITS - edits.length);
      if (commas === null) return;
      const allEdits = [...wrapper, ...edits, ...commas].sort((a, b) => a.offset - b.offset);
      if (allEdits.length === 0) return;
      let repaired = body;
      for (const edit of [...allEdits].reverse()) {
        repaired =
          repaired.slice(0, edit.offset) +
          edit.inserted +
          repaired.slice(edit.offset + edit.removed.length);
      }
      try {
        const identity = JSON.stringify(JSON.parse(repaired));
        if (result !== null && result.identity !== identity) ambiguous = true;
        else result = { body: repaired, repair: { originalBody: body, edits: allEdits }, identity };
      } catch {
        return;
      }
      return;
    }
    for (let index = start; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      const brace = tokens[candidate]!.text === '}';
      if ((brace ? braces : brackets) === 0) continue;
      visit(
        index + 1,
        new Set([...removed, candidate]),
        braces - Number(brace),
        brackets - Number(!brace)
      );
      if (exhausted || ambiguous) return;
    }
  };
  visit(0, new Set(), excess['}'], excess[']']);
  return exhausted || ambiguous ? null : result;
}

function tokenize(source: string, base: number): Token[] | null {
  const pattern =
    /\s+|"(?:[^"\\]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/y;
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match) return null;
    const text = match[0];
    if (!/^\s/.test(text)) {
      if (/^[\d\-tfn]/.test(text) && /[\w.+-]/.test(source[offset + text.length] ?? ''))
        return null;
      tokens.push({ text, offset: base + offset });
      if (tokens.length > MAX_TOKENS) return null;
    }
    offset += text.length;
  }
  return tokens;
}

function repairCommas(tokens: Token[], budget: number): JsonRepairEdit[] | null {
  let position = 0;
  const edits: JsonRepairEdit[] = [];
  const fail = () => {
    throw new Error('Unsupported JSON damage');
  };
  const add = (edit: JsonRepairEdit) => {
    edits.push(edit);
    if (edits.length > budget) fail();
  };
  const value = (depth: number): void => {
    if (depth > 128) fail();
    const token = tokens[position++];
    if (!token) return fail();
    if (token.text !== '{' && token.text !== '[') {
      if (/^(?:"|-?\d|true$|false$|null$)/.test(token.text)) return;
      return fail();
    }
    const object = token.text === '{';
    const closing = object ? '}' : ']';
    const keys = new Set<string>();
    if (tokens[position]?.text === closing) {
      position++;
      return;
    }
    for (;;) {
      if (object) {
        const key = tokens[position++];
        if (!key?.text.startsWith('"') || tokens[position++]?.text !== ':') return fail();
        const decoded = JSON.parse(key.text) as string;
        if (keys.has(decoded)) fail();
        keys.add(decoded);
      }
      value(depth + 1);
      const next = tokens[position];
      if (!next) return fail();
      if (next.text === closing) {
        position++;
        return;
      }
      if (next.text === ',') {
        position++;
        if (tokens[position]?.text === closing) {
          add({ offset: next.offset, removed: ',', inserted: '' });
          position++;
          return;
        }
      } else {
        if (object && (!next.text.startsWith('"') || tokens[position + 1]?.text !== ':'))
          return fail();
        add({ offset: next.offset, removed: '', inserted: ',' });
      }
    }
  };
  try {
    value(0);
    return position === tokens.length ? edits : null;
  } catch {
    return null;
  }
}
