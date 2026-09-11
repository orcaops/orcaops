import { createCanonicalWhyAction } from './canonical-why.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';

export type { CanonicalWhyOptions as WhyOptions } from '../lib/history-provenance.js';

export const whyAction = createCanonicalWhyAction({
  openContext: (selector) =>
    resolveDatabaseHistoryCommandContext({ profile: 'git-history', selector }),
});
