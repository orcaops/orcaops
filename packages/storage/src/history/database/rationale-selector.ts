import { z } from 'zod';

import { ProjectDatabaseError } from './errors.js';

const printable = (value: string) =>
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);

const Selector = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('capture'),
    id: z.uuid(),
    path: z.string().min(1).max(512).refine(printable),
  }),
  z.strictObject({ kind: z.literal('interpretation'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('correction'), id: z.uuid() }),
  z.strictObject({
    kind: z.literal('identity'),
    id: z.string().min(1).max(256).refine(printable),
    identity_kind: z.enum(['requirement', 'decision', 'claim', 'relationship']),
  }),
]);

export type RationaleSelector = z.infer<typeof Selector>;

export function rationaleSelector(value: RationaleSelector): string {
  const selected = Selector.parse(value);
  return selected.kind === 'identity'
    ? `${selected.identity_kind}:${selected.id}`
    : selected.kind === 'capture'
      ? `capture:${selected.id}:${selected.path}`
      : `${selected.kind}:${selected.id}`;
}

export function parseRationaleSelector(value: string): RationaleSelector {
  try {
    if (value.length > 1024 || !printable(value)) throw new Error();
    const colon = value.indexOf(':');
    const kind = value.slice(0, colon);
    const rest = value.slice(colon + 1);
    if (colon < 1) throw new Error();
    if (kind === 'capture') {
      const field = rest.indexOf(':');
      if (field < 1) throw new Error();
      return Selector.parse({ kind, id: rest.slice(0, field), path: rest.slice(field + 1) });
    }
    return Selector.parse(
      kind === 'interpretation' || kind === 'correction'
        ? { kind, id: rest }
        : { kind: 'identity', identity_kind: kind, id: rest }
    );
  } catch {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Expected an account selector returned by why: capture:<event-id>:<field>, interpretation:<id>, correction:<id>, or <identity-kind>:<id>'
    );
  }
}
