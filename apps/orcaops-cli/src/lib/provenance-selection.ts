import { rationaleTargetMatch } from '@orcaops/storage/history/database';

import { type Explanation, explanationConnection } from './provenance-explanations.js';

export const ORDINARY_EXPLANATION_BYTES = 16_384;
export const EXPLANATION_TARGET_BYTES = 20_480;
export const ORDINARY_EXPLANATION_COUNT = 6;

export function isPrimaryExplanation(item: Explanation, file: string, includeContext = true) {
  if (item.relevance.support || item.relevance.target.kind === 'explicit_path') return true;
  const connection = explanationConnection(item);
  if (connection > 1) return false;
  const basename =
    file
      .replaceAll('\\', '/')
      .split('/')
      .at(-1)
      ?.replace(/\.[^.]+$/, '') ?? '';
  const terms = rationaleTargetMatch(basename, file).terms;
  if (terms.length && terms.every((term) => item.relevance.target.terms.includes(term)))
    return true;
  if (item.kind === 'decision')
    return Boolean(item.account?.alternatives?.length || (includeContext && item.account?.reason));
  return false;
}
