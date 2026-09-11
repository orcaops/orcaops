import { type NormalizedText, normalizeForDetection } from './normalize.js';
import { stripTerminalFormatting } from './terminal.js';
export const REDACTION_MARKER = '[REDACTED_SECRET]';
export interface SecretPattern {
  name: string;
  regex: RegExp;
  classify?: (value: string) => string;
}
function characterClassCount(value: string): number {
  return Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/[0-9]/.test(value));
}
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
const PADDING_RUN = /(.)\1{5,}/u;
const SOLID_ALNUM_RUN = /^[A-Za-z0-9]+$/;
function isCredentialShapedValue(value: string): boolean {
  if (PADDING_RUN.test(value)) return false;
  if (value.length >= 24 && characterClassCount(value) >= 3) return true;
  return value.length >= 32 && SOLID_ALNUM_RUN.test(value) && shannonEntropy(value) >= 3.0;
}
export const STRONG_ASSIGNMENT_PATTERN_NAME = 'generic-assignment-strong';
export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  {
    name: 'bearer-token',
    regex: /\bBearer\s+((?=[A-Za-z0-9._\-+/=]*[0-9._+/=])[A-Za-z0-9._\-+/=]{16,})/g,
  },
  {
    name: 'jwt',
    regex:
      /(?<![A-Za-z0-9_])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
  },
  {
    name: 'authorization-header',
    regex:
      /\b(?:authorization)\s*:\s*((?:bearer|basic|token|api[-_]?key)\s+(?=[A-Za-z0-9._~+\-/=]*(?:[0-9_+/=]|\.[A-Za-z0-9_~+\-/=]))[A-Za-z0-9._~+\-/=]{8,})(?![A-Za-z0-9._~+\-/=])/gi,
  },
  {
    name: 'authorization-header',
    regex:
      /\b(?:authorization)\s*:\s*((?:bearer|basic|token|api[-_]?key)\s+(?![A-Za-z0-9._~+\-/=]*[0-9._+/=])[A-Za-z0-9._~+\-/=]{8,})[ \t]*(?=$|[\r\n])/gim,
  },
  {
    name: 'secret-query-param',
    regex: /[?&](?:token|access_token|api_key)=([A-Za-z0-9._~%+\-/=]{16,})/gi,
  },
  { name: 'anthropic-api-key', regex: /sk-ant-[A-Za-z0-9_-]{40,}/g },
  { name: 'openai-project-key', regex: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai-legacy-key', regex: /\bsk-(?!ant-|proj-)[A-Za-z0-9]{32,}\b/g },
  { name: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  {
    name: 'google-api-key',
    regex: /(?<![0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  },
  { name: 'aws-access-key-id', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'slack-token', regex: /\b(?:xoxe\.)?xox[baprse]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'slack-app-token', regex: /\bxapp-1-[A-Za-z0-9-]{10,}\b/g },
  { name: 'npm-token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    name: 'azure-client-secret',
    regex: /(?<![A-Za-z0-9._~-])[A-Za-z0-9._~-]{1,8}8Q~[A-Za-z0-9._~-]{30,}(?![A-Za-z0-9._~-])/g,
  },
  {
    name: 'generic-assignment',
    classify: (value) =>
      isCredentialShapedValue(value) ? STRONG_ASSIGNMENT_PATTERN_NAME : 'generic-assignment',
    regex:
      /(?<![A-Za-z0-9])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|aws[_-]?secret[_-]?access[_-]?key|client[_-]?secret|private[_-]?token|auth[_-]?token|bearer[_-]?token|password|secret|token)(?:[_-]?key)?["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{8,})["']?/gi,
  },
];
export function redactSecrets(text: string): string {
  return redactBothPasses(text, SECRET_PATTERNS);
}
function secretRanges(
  text: string,
  patterns: ReadonlyArray<SecretPattern>
): readonly RedactionRange[] {
  const direct = collectRedactionRanges(text, patterns);
  const normalized = normalizeForDetection(text);
  const obfuscated =
    normalized === null
      ? []
      : mapNormalizedRanges(normalized, collectRedactionRanges(normalized.text, patterns));
  const found = mergeRedactionRanges([...direct, ...obfuscated]);
  if (found.length === 0) return found;
  const rescanned = collectPatternRanges(maskFoundRanges(text, found), patterns);
  return rescanned.length === 0 ? found : mergeRedactionRanges([...found, ...rescanned]);
}
function maskFoundRanges(text: string, ranges: readonly RedactionRange[]): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    chunks.push(text.slice(cursor, range.start), '\u0000'.repeat(range.end - range.start));
    cursor = range.end;
  }
  chunks.push(text.slice(cursor));
  return chunks.join('');
}
function redactBothPasses(text: string, patterns: ReadonlyArray<SecretPattern>): string {
  const ranges = secretRanges(text, patterns);
  return ranges.length === 0 ? text : redactRanges(text, ranges);
}
export const PRIVATE_KEY_PATTERN_NAME = 'pem-private-key';
export function scrubEvaluatorOutput(text: string): string {
  return redactSecrets(stripTerminalFormatting(text));
}
export function redactSecretsInValue<T>(value: T): T {
  return walkRedact(value, false) as T;
}
interface RedactionRange {
  start: number;
  end: number;
  names: string[];
}
function collectRedactionRanges(
  text: string,
  patterns: ReadonlyArray<SecretPattern>
): RedactionRange[] {
  return mergeRedactionRanges([
    ...privateKeyRanges(text).map(({ start, end }) => ({
      start,
      end,
      names: [PRIVATE_KEY_PATTERN_NAME],
    })),
    ...collectPatternRanges(text, patterns),
  ]);
}
function collectPatternRanges(
  text: string,
  patterns: ReadonlyArray<SecretPattern>
): RedactionRange[] {
  const ranges: RedactionRange[] = [];
  for (const { name, regex, classify } of patterns) {
    regex.lastIndex = 0;
    for (;;) {
      const match = regex.exec(text);
      if (match === null) break;
      const captured = match[1];
      if (typeof captured === 'string' && captured.length > 0) {
        const capturedAt = match[0].lastIndexOf(captured);
        ranges.push({
          start: match.index + capturedAt,
          end: match.index + capturedAt + captured.length,
          names: [classify === undefined ? name : classify(captured)],
        });
      } else {
        ranges.push({ start: match.index, end: match.index + match[0].length, names: [name] });
      }
    }
    regex.lastIndex = 0;
  }
  return mergeRedactionRanges(ranges);
}
function mergeRedactionRanges(ranges: RedactionRange[]): RedactionRange[] {
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: RedactionRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
      for (const name of range.names) {
        if (!previous.names.includes(name)) previous.names.push(name);
      }
    } else {
      merged.push({ ...range, names: [...range.names] });
    }
  }
  return merged;
}
function mapNormalizedRanges(
  normalized: NormalizedText,
  ranges: readonly RedactionRange[]
): RedactionRange[] {
  const mapped: RedactionRange[] = [];
  for (const range of ranges) {
    if (range.end <= range.start) continue;
    mapped.push({
      start: normalized.start[range.start]!,
      end: normalized.end[range.end - 1]!,
      names: [...range.names],
    });
  }
  return mapped;
}
function redactRanges(text: string, ranges: readonly RedactionRange[]): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    chunks.push(text.slice(cursor, range.start), REDACTION_MARKER);
    cursor = range.end;
  }
  chunks.push(text.slice(cursor));
  return chunks.join('');
}
interface PrivateKeyRange {
  start: number;
  end: number;
  terminated: boolean;
}
interface PrivateKeyHeader {
  end: number;
  label: string;
  suffix: string;
}
const PRIVATE_KEY_BEGIN = '-----BEGIN ';
const PRIVATE_KEY_END = '-----END ';
const PRIVATE_KEY_HEADER_SUFFIXES = ['PRIVATE KEY BLOCK-----', 'PRIVATE KEY-----'];
const PEM_BODY_TOKEN_LINE = /^[A-Za-z0-9+/=_\\-]+$/;
const PEM_MARKER_LINE = /^-----(?:BEGIN|END)\s/;
const PEM_BASE64_RUN = /[A-Za-z0-9+/=]{40,}/;
const PEM_BASE64_RUNS = /[A-Za-z0-9+/=]{40,}/g;
const PEM_BASE64_RUN_LINE = /^[A-Za-z0-9+/=]{40,}$/;
const PEM_BASE64_CHAR = /[A-Za-z0-9+/=]/;
const PEM_BASE64_TAIL = /[A-Za-z0-9+/=]{8,}/g;
interface PemMaterialShape {
  prefix: number;
  width: number;
}
const PEM_HEADER_VALUE_AT = /(?<=[A-Za-z][A-Za-z0-9-]*:[ \t]*)/y;
function isPemHeaderValueRun(line: string, at: number): boolean {
  PEM_HEADER_VALUE_AT.lastIndex = at;
  return PEM_HEADER_VALUE_AT.test(line);
}
function pemMaterialShape(line: string, trimmed: string): PemMaterialShape | null {
  if (PEM_BODY_TOKEN_LINE.test(trimmed)) {
    return { prefix: line.indexOf(trimmed), width: trimmed.length };
  }
  let shape: PemMaterialShape | null = null;
  for (const run of line.matchAll(PEM_BASE64_RUNS)) {
    if (isPemHeaderValueRun(line, run.index)) continue;
    shape = { prefix: run.index, width: run[0].length };
  }
  return shape;
}
function pemMaterialDominates(line: string, prefix: number, width: number): boolean {
  const tail = line.slice(prefix);
  const rest = tail.trim();
  if (rest.length === 0) return false;
  if (
    PEM_BASE64_RUN_LINE.test(rest) &&
    (prefix === 0 || tail.length > rest.length || !PEM_BASE64_CHAR.test(line[prefix - 1]))
  ) {
    return true;
  }
  let longest = 0;
  for (const run of rest.matchAll(PEM_BASE64_TAIL)) {
    if (run[0].length > width) continue;
    if (run[0].length > longest) longest = run[0].length;
  }
  return longest * 2 >= rest.length;
}
function pemRunAt(line: string, at: number, width: number): boolean {
  if (at + width > line.length) return false;
  if (at > 0 && PEM_BASE64_CHAR.test(line[at - 1]!)) return false;
  if (at + width < line.length && PEM_BASE64_CHAR.test(line[at + width]!)) return false;
  for (let cursor = at; cursor < at + width; cursor += 1) {
    if (!PEM_BASE64_CHAR.test(line[cursor]!)) return false;
  }
  return true;
}
function isPemContinuationLine(line: string, shape: PemMaterialShape): boolean {
  if (pemMaterialDominates(line, shape.prefix, shape.width)) return true;
  const earliest = line.trimEnd().length - 2 * Math.min(shape.width, PEM_MAX_ANCHOR_WIDTH);
  const decorating = pemRunAt(line, shape.prefix, shape.width);
  for (const run of line.matchAll(PEM_BASE64_RUNS)) {
    if (run.index < earliest) continue;
    const width =
      decorating && run.index > shape.prefix ? Math.max(shape.width, run[0].length) : shape.width;
    if (run[0].length > width) continue;
    if (pemMaterialDominates(line, run.index, width)) return true;
  }
  return false;
}
const PEM_MAX_DRY_LINES = 4;
const PEM_MAX_HEADER_LINES = 4;
const PEM_MAX_HEADER_GAP = 2;
const PEM_MAX_ENCAPSULATED_HEADERS = 8;
const PEM_MAX_ANCHOR_WIDTH = 128;
const PEM_ENCAPSULATED_HEADER = /^[A-Za-z][A-Za-z0-9-]*:[ \t]*\S/;
function pemDryBudget(shape: PemMaterialShape | null, headerLines: number): number {
  if (shape !== null) return PEM_MAX_DRY_LINES;
  return headerLines > 0 ? PEM_MAX_HEADER_GAP : PEM_MAX_HEADER_LINES;
}
function pemBodyLines(span: string): string[] {
  return span.replace(/\\r\\n|\\n|\\r/g, '\n').split(/\r\n|\n|\r/);
}
function isPrivateKeyBody(span: string): boolean {
  let sawMaterial = false;
  let clean = true;
  for (const line of pemBodyLines(span)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (PEM_BASE64_RUN.test(line) || PEM_BODY_TOKEN_LINE.test(trimmed)) {
      sawMaterial = true;
      continue;
    }
    if (PEM_MARKER_LINE.test(trimmed)) continue;
    if (!sawMaterial && PEM_ENCAPSULATED_HEADER.test(trimmed)) continue;
    clean = false;
  }
  return sawMaterial && clean;
}
function privateKeyBodyRunEnd(text: string, from: number): number {
  let cursor = from;
  let end = -1;
  let dryLines = 0;
  let headerLines = 0;
  let shape: PemMaterialShape | null = null;
  while (cursor <= text.length) {
    let lineEnd = cursor;
    while (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') {
      if (startsWithEscapedLineBreak(text, lineEnd)) break;
      lineEnd += 1;
    }
    const line = text.slice(cursor, lineEnd);
    const trimmed = line.trim();
    const material =
      shape === null
        ? PEM_BODY_TOKEN_LINE.test(trimmed) || PEM_BASE64_RUN.test(line)
        : PEM_BODY_TOKEN_LINE.test(trimmed) || isPemContinuationLine(line, shape);
    if (trimmed.length > 0) {
      if (end >= 0 && line.includes(PRIVATE_KEY_END)) {
        end = lineEnd;
        break;
      }
      if (material) {
        end = lineEnd;
        dryLines = 0;
        shape ??= pemMaterialShape(line, trimmed);
      } else if (
        shape === null &&
        dryLines === 0 &&
        headerLines < PEM_MAX_ENCAPSULATED_HEADERS &&
        PEM_ENCAPSULATED_HEADER.test(trimmed)
      ) {
        headerLines += 1;
      } else if (++dryLines >= pemDryBudget(shape, headerLines)) {
        break;
      }
    }
    if (lineEnd >= text.length) break;
    cursor = startsWithEscapedLineBreak(text, lineEnd) ? lineEnd + 2 : lineEnd + 1;
  }
  return end;
}
function privateKeyRanges(text: string): PrivateKeyRange[] {
  const ranges: PrivateKeyRange[] = [];
  let cursor = 0;
  let terminatorsExhausted = false;
  while (cursor < text.length) {
    const start = text.indexOf(PRIVATE_KEY_BEGIN, cursor);
    if (start < 0) break;
    const beginHeader = parsePrivateKeyHeader(text, start, PRIVATE_KEY_BEGIN);
    if (beginHeader === null) {
      cursor = start + PRIVATE_KEY_BEGIN.length;
      continue;
    }
    let endSearch = beginHeader.end;
    let end = text.length;
    let terminated = false;
    while (!terminatorsExhausted) {
      const candidate = text.indexOf(PRIVATE_KEY_END, endSearch);
      if (candidate < 0) {
        terminatorsExhausted = true;
        break;
      }
      const candidateHeader = parsePrivateKeyHeader(text, candidate, PRIVATE_KEY_END);
      if (
        candidateHeader !== null &&
        candidateHeader.label === beginHeader.label &&
        candidateHeader.suffix === beginHeader.suffix &&
        isPrivateKeyTerminatorLine(text, candidate, candidateHeader.end)
      ) {
        if (!isPrivateKeyBody(text.slice(beginHeader.end, candidate))) break;
        end = candidateHeader.end;
        terminated = true;
        break;
      }
      endSearch = candidate + PRIVATE_KEY_END.length;
    }
    if (!terminated) {
      const runEnd = privateKeyBodyRunEnd(text, beginHeader.end);
      if (runEnd < 0) {
        cursor = beginHeader.end;
        continue;
      }
      end = runEnd;
    }
    ranges.push({ start, end, terminated });
    cursor = end;
  }
  return ranges;
}
function parsePrivateKeyHeader(
  text: string,
  start: number,
  prefix: string
): PrivateKeyHeader | null {
  if (!text.startsWith(prefix, start)) return null;
  let cursor = start + prefix.length;
  const labelStart = cursor;
  while (cursor < text.length) {
    for (const suffix of PRIVATE_KEY_HEADER_SUFFIXES) {
      if (text.startsWith(suffix, cursor)) {
        return { end: cursor + suffix.length, label: text.slice(labelStart, cursor), suffix };
      }
    }
    const code = text.charCodeAt(cursor);
    if (code !== 32 && (code < 65 || code > 90)) return null;
    cursor += 1;
  }
  return null;
}
function isPrivateKeyTerminatorLine(text: string, start: number, end: number): boolean {
  let before = start;
  while (before > 0 && (text[before - 1] === ' ' || text[before - 1] === '\t')) before -= 1;
  const startsLine =
    before === 0 ||
    text[before - 1] === '\n' ||
    text[before - 1] === '\r' ||
    endsWithEscapedLineBreak(text, before);
  if (!startsLine) return false;
  let after = end;
  while (after < text.length && (text[after] === ' ' || text[after] === '\t')) after += 1;
  return (
    after === text.length ||
    text[after] === '\n' ||
    text[after] === '\r' ||
    startsWithEscapedLineBreak(text, after)
  );
}
function endsWithEscapedLineBreak(text: string, end: number): boolean {
  const marker = text[end - 1];
  if (marker !== 'n' && marker !== 'r') return false;
  let cursor = end - 2;
  let backslashes = 0;
  while (cursor >= 0 && text[cursor] === '\\') {
    backslashes += 1;
    cursor -= 1;
  }
  return backslashes % 2 === 1;
}
function startsWithEscapedLineBreak(text: string, start: number): boolean {
  let cursor = start;
  while (cursor < text.length && text[cursor] === '\\') cursor += 1;
  const backslashes = cursor - start;
  return backslashes === 1 && (text[cursor] === 'n' || text[cursor] === 'r');
}
function walkRedact(value: unknown, redactKeys: boolean, scrubControls = false): unknown {
  const redactText = scrubControls ? scrubEvaluatorOutput : redactSecrets;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    return value.map((child) => walkRedact(child, redactKeys, scrubControls));
  }
  if (isPlainJsonObject(value)) {
    const usedKeys = new Set<string>();
    const nextSuffixes = new Map<string, number>();
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const candidate = redactKeys ? redactText(key) : key;
        const outputKey = redactKeys
          ? uniqueOutputKey(candidate, usedKeys, nextSuffixes)
          : candidate;
        usedKeys.add(outputKey);
        return [outputKey, walkRedact(child, redactKeys, scrubControls)];
      })
    );
  }
  return value;
}
function uniqueOutputKey(
  candidate: string,
  usedKeys: ReadonlySet<string>,
  nextSuffixes: Map<string, number>
): string {
  if (!usedKeys.has(candidate)) return candidate;
  let suffix = nextSuffixes.get(candidate) ?? 2;
  while (usedKeys.has(`${candidate}#${suffix}`)) suffix += 1;
  nextSuffixes.set(candidate, suffix + 1);
  return `${candidate}#${suffix}`;
}
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
