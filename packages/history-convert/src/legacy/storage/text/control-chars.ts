import { z } from 'zod';
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const UNIT_SEP = 0x1f;
const DEL = 0x7f;
const C1_END = 0x9f;
const SEGMENTS_PER_BLOCK = 1024;
function isForbiddenCode(code: number): boolean {
  if (code === TAB || code === LF || code === CR) return false;
  return code <= UNIT_SEP || (code >= DEL && code <= C1_END);
}
export function containsForbiddenControlChars(s: string): boolean {
  return firstForbiddenControlChar(s) !== null;
}
export function firstForbiddenControlChar(s: string): {
  index: number;
  code: number;
} | null {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (isForbiddenCode(code)) return { index: i, code };
  }
  return null;
}
export function stripControlChars(s: string): string {
  let cursor = 0;
  while (cursor < s.length && !isForbiddenCode(s.charCodeAt(cursor))) cursor += 1;
  if (cursor === s.length) return s;
  const blocks: string[] = [];
  const segments: string[] = [];
  let cleanStart = 0;
  for (; cursor < s.length; cursor += 1) {
    if (!isForbiddenCode(s.charCodeAt(cursor))) continue;
    if (cleanStart < cursor) segments.push(s.slice(cleanStart, cursor));
    cleanStart = cursor + 1;
    if (segments.length === SEGMENTS_PER_BLOCK) {
      blocks.push(segments.join(''));
      segments.length = 0;
    }
  }
  if (cleanStart < s.length) segments.push(s.slice(cleanStart));
  if (segments.length > 0) blocks.push(segments.join(''));
  return blocks.join('');
}
export function deepStripControlChars(value: unknown): unknown {
  if (typeof value === 'string') return stripControlChars(value);
  if (Array.isArray(value)) return value.map((v) => deepStripControlChars(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[stripControlChars(k)] = deepStripControlChars(v);
    }
    return out;
  }
  return value;
}
export function collectControlCharPaths(value: unknown, base = ''): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (containsForbiddenControlChars(v)) out.push(path === '' ? '(root)' : path);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const cleanKey = stripControlChars(k);
        if (containsForbiddenControlChars(k)) {
          out.push(path === '' ? `{key ${cleanKey}}` : `${path}.{key ${cleanKey}}`);
        }
        walk(val, path === '' ? cleanKey : `${path}.${cleanKey}`);
      }
    }
  };
  walk(value, base);
  return out;
}
export class ForbiddenControlCharError extends Error {
  readonly name = 'ForbiddenControlCharError';
  readonly path: string;
  constructor(path: string) {
    super(
      `forbidden control character at ${path === '' ? '(root)' : path}` +
        ` — a NUL or other disallowed control byte cannot be stored by the cloud`
    );
    this.path = path;
  }
}
export function assertNoForbiddenControlChars(value: unknown): void {
  const paths = collectControlCharPaths(value);
  if (paths.length > 0) throw new ForbiddenControlCharError(paths[0]);
}
type StringSchema = z.ZodType<string, string>;
export const nonBlank = (s: string): boolean => s.trim().length > 0;
export const textPolicyRegistry = z.registry<{
  policy: 'prose' | 'identifier';
}>();
export function textPolicyOf(schema: z.ZodType): 'prose' | 'identifier' | undefined {
  return textPolicyRegistry.get(schema)?.policy;
}
export function proseText(constraint: StringSchema = z.string()) {
  return z
    .string()
    .transform(stripControlChars)
    .pipe(constraint)
    .refine(nonBlank, 'must not be blank')
    .register(textPolicyRegistry, { policy: 'prose' });
}
export function identifierText(constraint: StringSchema = z.string().min(1)) {
  return constraint
    .refine((s) => !containsForbiddenControlChars(s), {
      message: 'must not contain control characters',
    })
    .register(textPolicyRegistry, { policy: 'identifier' });
}
