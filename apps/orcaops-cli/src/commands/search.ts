import { createCanonicalSearchAction } from './canonical-search.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';

export const searchAction = createCanonicalSearchAction({
  openContext: (selector) =>
    resolveDatabaseHistoryCommandContext({ profile: 'collection', selector }),
});
