import { z } from 'zod';

type Def = Record<string, unknown> & { type: string };
type Schema = z.ZodType & { _zod: { def: Def; constr: new (def: Def) => z.ZodType } };

const WRAPPERS_WITH_INNER_TYPE = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'nonoptional',
  'readonly',
  'catch',
]);

// Zod strips unknown keys by default, so a misspelled field (e.g. `completed_steps`)
// would silently fall back to its default; reject them at every nesting level.
export function strictInput<T extends z.ZodType>(schema: T): T {
  return strictSchema(schema as unknown as Schema) as unknown as T;
}

function strictSchema(schema: Schema): Schema {
  const def = schema._zod.def;
  if (def.type === 'object') {
    const shape = Object.fromEntries(
      Object.entries(def.shape as Record<string, Schema>).map(([key, value]) => [
        key,
        strictSchema(value),
      ])
    );
    const known = Object.keys(shape);
    return rebuild(schema, {
      shape,
      catchall: z.never(),
      error: (issue: { code: string; keys?: string[] }) =>
        issue.code === 'unrecognized_keys'
          ? unknownKeysMessage(issue.keys ?? [], known)
          : undefined,
    });
  }
  if (def.type === 'array') return replaceChildren(schema, ['element']);
  if (def.type === 'pipe') return replaceChildren(schema, ['in', 'out']);
  if (WRAPPERS_WITH_INNER_TYPE.has(def.type)) return replaceChildren(schema, ['innerType']);
  return schema;
}

function replaceChildren(schema: Schema, keys: readonly string[]): Schema {
  const def = schema._zod.def;
  const children = Object.fromEntries(keys.map((key) => [key, strictSchema(def[key] as Schema)]));
  return keys.every((key) => children[key] === def[key]) ? schema : rebuild(schema, children);
}

function rebuild(schema: Schema, changes: Record<string, unknown>): Schema {
  const Constructor = schema._zod.constr;
  return new Constructor({ ...schema._zod.def, ...changes }) as Schema;
}

export function unknownKeysMessage(keys: readonly string[], known: readonly string[]): string {
  const named = keys.map((key) => {
    const suggestion = closestKey(key, known);
    return suggestion === undefined ? `"${key}"` : `"${key}" (did you mean "${suggestion}"?)`;
  });
  return `Unknown key${keys.length === 1 ? '' : 's'} ${named.join(', ')}`;
}

function closestKey(key: string, known: readonly string[]): string | undefined {
  let best: { key: string; distance: number } | undefined;
  for (const candidate of known) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    const limit = Math.max(2, Math.floor(Math.max(key.length, candidate.length) / 3));
    if (distance <= limit && (best === undefined || distance < best.distance))
      best = { key: candidate, distance };
  }
  return best?.key;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}
