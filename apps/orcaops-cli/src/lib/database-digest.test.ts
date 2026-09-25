import { afterEach, describe, expect, it } from 'vitest';

import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { getDefaultConfig } from '@orcaops/storage';

import {
  DIGEST_SIBLING_LIMIT,
  readDatabaseBranchDigest,
  selectDigestSiblingRows,
  validateDatabaseDigest,
} from './database-digest.js';
import { fixture } from '../../tests/helpers/database-history.js';

const readers = new Set<{ close(): void }>();
afterEach(() => {
  for (const reader of readers) reader.close();
  readers.clear();
});

describe('selectDigestSiblingRows', () => {
  it('keeps live siblings visible and caps a large imported corpus', () => {
    const live = [{ id: 'live-a' }, { id: 'live-b', origin: 'captured' as const }];
    const imported = Array.from({ length: 30 }, (_, index) => ({
      id: `imported-${index}`,
      origin: 'git-import' as const,
    }));

    const selected = selectDigestSiblingRows([...imported, ...live]);
    expect(selected).toHaveLength(DIGEST_SIBLING_LIMIT);
    expect(selected.slice(0, 2).map((row) => row.id)).toEqual(['live-a', 'live-b']);
    expect(selected.filter((row) => row.origin === 'git-import')).toHaveLength(
      DIGEST_SIBLING_LIMIT - live.length
    );
  });
});

describe('readDatabaseBranchDigest', { timeout: 60_000 }, () => {
  it("refuses an incomplete branch-wide collection with its first issue's own message", async () => {
    const f = await fixture();
    const scope = await resolveDatabaseHistoryScope({
      root: f.root,
      cwd: f.main,
      profile: 'git-history',
      selector: {},
    });
    readers.add(scope);
    const issue = {
      code: 'HISTORY_FORMAT_UNSUPPORTED',
      project_id: f.authority.projectId,
      message: 'Use a build that supports this history format',
    };
    const context = {
      scope: { ...scope, completeness: { complete: false, issues: [issue] } },
      config: getDefaultConfig(),
    };
    await expect(
      readDatabaseBranchDigest(
        context,
        validateDatabaseDigest({ branchWide: true, base: 'main' }),
        new Map()
      )
    ).rejects.toMatchObject({ code: issue.code, message: issue.message });
  });
});
