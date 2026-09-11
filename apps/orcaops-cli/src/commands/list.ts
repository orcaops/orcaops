import type { ArtifactState, ArtifactStatus } from '@orcaops/storage';

import { createDatabaseListAction } from './database-list.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import { assertWindowOrdered, parseLimit, parseSince, parseUntil } from '../lib/read-window.js';

export type { DatabaseListOptions as ListOptions } from '../lib/database-list.js';
export { DEFAULT_BARE_LIST_LIMIT, resolveListLimit } from '../lib/database-list.js';
export {
  collectBetweenArtifacts,
  collectTouchingRollup,
  parseBetweenRange,
  TOUCHING_NOTE,
} from '../lib/list-provenance.js';
export type { BetweenArtifactInput, TouchingHit } from '../lib/list-provenance.js';

const VALID_STATES: ArtifactState[] = ['planned', 'active', 'blocked', 'summarized'];

export interface StateFilter {
  status: ArtifactStatus;
  state: ArtifactState;
}

export function parseStateFilter(raw: string | undefined): StateFilter | undefined {
  if (raw === undefined) return undefined;
  if (!VALID_STATES.includes(raw as ArtifactState)) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `--state must be one of: ${VALID_STATES.join(', ')}; got "${raw}".`,
      'state'
    );
  }
  if (raw === 'summarized') return { status: 'complete', state: 'summarized' };
  return { status: 'active', state: raw as ArtifactState };
}

export { assertWindowOrdered, parseLimit, parseSince, parseUntil };

export const listAction = createDatabaseListAction({
  openContext: (selector, between) =>
    resolveDatabaseHistoryCommandContext({
      profile: between === undefined ? 'collection' : 'git-history',
      selector,
      gitRange: between,
    }),
});
