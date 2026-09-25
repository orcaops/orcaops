import { z } from 'zod';

import type { EventType } from '../../events/event-log.js';
import { searchFieldsForEvent } from '../search-content/fields.js';
import { tokenizeSearchText } from '../search-content/matching.js';

export const RATIONALE_INDEX_VERSION = 1;
export const RATIONALE_ACCOUNT_BYTES = 32_768;
export const RATIONALE_EVENT_ACCOUNTS = 128;
export const RATIONALE_ACCOUNT_TERMS = 256;

export const RationaleAccountSchema = z.strictObject({
  path: z.string(),
  kind: z.enum(['decision', 'criterion', 'context']),
  wording: z.string(),
  reason: z.string().nullable(),
  alternatives: z.array(
    z.strictObject({ option: z.string(), rejected_because: z.string().nullable() })
  ),
});
export type RationaleAccount = z.infer<typeof RationaleAccountSchema>;

export function rationaleAccounts(type: EventType, payload: unknown): RationaleAccount[] {
  const fields = searchFieldsForEvent(type, payload).body;
  const byPath = new Map(fields.map((field) => [field.path, field.text]));
  return fields.flatMap((field): RationaleAccount[] => {
    const decision = /^decisions\.\d+\.decision$/.test(field.path);
    const criterion = /acceptance_criteria\.\d+\.text$/.test(field.path);
    const context = ['rationale', 'summary', 'outcome'].includes(field.path);
    if (!decision && !criterion && !context) return [];
    const root = decision ? field.path.slice(0, -'.decision'.length) : null;
    return [
      {
        path: field.path,
        kind: decision ? 'decision' : criterion ? 'criterion' : 'context',
        wording: field.text,
        reason: root === null ? null : (byPath.get(`${root}.reason`) ?? null),
        alternatives:
          root === null
            ? []
            : fields
                .filter(
                  (other) =>
                    other.path.startsWith(`${root}.alternatives_considered.`) &&
                    other.path.endsWith('.option')
                )
                .map((other) => ({
                  option: other.text,
                  rejected_because:
                    byPath.get(other.path.replace(/\.option$/, '.rejected_because')) ?? null,
                })),
      },
    ];
  });
}

export function rationaleAccountText(
  account: Pick<RationaleAccount, 'wording' | 'reason' | 'alternatives'>
): string {
  return [
    account.wording,
    account.reason ?? '',
    ...account.alternatives.flatMap((entry) => [entry.option, entry.rejected_because ?? '']),
  ].join(' ');
}

const COMMON = new Set(
  'a an and are as at be been being but by can could did do does for from had has have if in into is it its may must no not of on or our should so than that the their then there these they this those to use used using was we were when where which while will with without would you your'.split(
    ' '
  )
);

export function rationaleTerms(text: string): string[] {
  return [
    ...new Set(
      tokenizeSearchText(text).filter(
        (term) => term.length >= 2 && term.length <= 64 && !COMMON.has(term)
      )
    ),
  ];
}
