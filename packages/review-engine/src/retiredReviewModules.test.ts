// The retired review file-publication modules must stay retired. A deletion
// that a later change quietly restores is the hidden fallback the cutover
// exists to remove, and neither a type error nor a failing suite would catch a
// re-added module that nothing calls yet.

import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import * as engine from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Deleted module → the retained authority that replaced what it published. */
const RETIRED_MODULES: Record<string, string> = {
  'archive.ts': 'comments and workflow events are retained rows, never a mirrored second copy',
  'durableState.ts': 'review state health reads retained rows through database/read-context.ts',
  'durableState.test.ts': 'database/health.test.ts covers the canonical health surface',
  'currentStory.ts': 'the selected Story is retained with the current review run',
  'currentStory.test.ts': 'database pane tests cover retained Story selection and integrity',
  'reviewState.ts': 'database/health.ts reads retained review state without a file marker',
  'reviewState.test.ts': 'database/health.test.ts covers current retained-state health',
  'stickyBase.ts': 'explicit base policy is retained in review base revisions',
  'storePreparation.ts': 'database readers enforce exact retained history completeness',
  'storePreparation.test.ts': 'database read-context tests cover incomplete retained history',
  'retiredLeftovers.test.ts':
    'database/health.test.ts asserts that stray review-directory files cannot move canonical health',
};

/** Deleted export → why no successor name replaces it. */
const RETIRED_EXPORTS: Record<string, string> = {
  ReviewArchiveWarning: 'the archive mirror is retired, so no caller can be warned about it',
  validateReviewLogFiles:
    'there are no append log files to validate; a retained revision is validated by its own record decoder',
  runDurableState: 'review state health and the state-repair refusal replace it',
  inspectDurableReviewState: 'readDatabaseReviewHealth inspects retained rows instead',
  readCommentEventsStrict: 'comment revisions are decoded from their retained bytes',
  readJournalEventsStrict: 'workflow events are decoded from their retained bytes',
  DurableStateReadError: 'a malformed retained record raises the store integrity refusal',
  CURRENT_STORY_POINTER_SCHEMA_VERSION: 'Story selection is retained with the review run',
  CURRENT_STORY_POINTER_FILE: 'Story selection has no file pointer',
  REVIEW_STATE_VERSION: 'retained review records carry their own schema versions',
  ensureReviewStateVersion: 'reads never initialize a review-state directory',
  reviewFloorLockKey: 'SQLite transaction coordination replaces the review directory lock',
  reviewLocksDir: 'SQLite transaction coordination replaces the review directory lock',
};

it.each(Object.entries(RETIRED_MODULES))('keeps %s deleted (%s)', async (file) => {
  await expect(access(path.join(here, file))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('exports none of the retired review file-publication names', () => {
  const exported = Object.keys(engine);
  for (const name of Object.keys(RETIRED_EXPORTS)) expect(exported).not.toContain(name);
});
