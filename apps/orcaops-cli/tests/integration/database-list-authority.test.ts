import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';

import {
  registrationBytes,
  sealRegistration,
} from '../../../../packages/core/dist/history/registration-files-format.js';
import { resolveDatabaseHistoryCommandContext } from '../../src/lib/database-history-context.js';
import { readDatabaseRangeList } from '../../src/lib/database-list-range.js';
import { fixture, inventory } from '../helpers/database-history.js';

describe('recorded range authority revalidation', { timeout: 30_000 }, () => {
  it.each(['store', 'root', 'initialization'] as const)(
    'refuses a changed %s tuple in the actual repository marker',
    async (changed) => {
      const f = await fixture();
      await f.capture();
      const context = await resolveDatabaseHistoryCommandContext({
        profile: 'collection',
        gitRange: 'HEAD..HEAD',
        cwd: f.main,
        dataRoot: f.root,
      });
      const marker = path.join(context.scope.gitContext!.commonDir, 'orcaops', 'registration.json');
      const bytes = await readFile(marker);
      const registration = JSON.parse(bytes.toString());
      if (changed === 'store') registration.authority.store_instance_id = uuidv7();
      else if (changed === 'root') {
        const root = await normalizeHistoryRoot({ root: path.join(f.temporary, 'other-data') });
        registration.authority.resolved_root = root.resolvedRoot;
        registration.authority.root_key = root.rootKey;
      } else registration.initialization_operation_id = uuidv7();
      try {
        delete registration.hash;
        await writeFile(marker, registrationBytes(sealRegistration(registration)));
        const before = await inventory(f.temporary);
        await expect(
          readDatabaseRangeList(context, { between: 'HEAD..HEAD' })
        ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
        expect(await inventory(f.temporary)).toEqual(before);
      } finally {
        await writeFile(marker, bytes);
        context.scope.close();
      }
    }
  );
  it('accepts the unchanged original registration without modifying history', async () => {
    const f = await fixture();
    const context = await resolveDatabaseHistoryCommandContext({
      profile: 'collection',
      gitRange: 'HEAD..HEAD',
      cwd: f.main,
      dataRoot: f.root,
    });
    try {
      const before = await inventory(f.temporary);
      const result = await readDatabaseRangeList(context, { between: 'HEAD..HEAD' });
      expect(result.between.from_sha).toBe(f.context.headOid);
      expect(result.between.to_sha).toBe(f.context.headOid);
      expect(result.results).toEqual([]);
      expect(await inventory(f.temporary)).toEqual(before);
    } finally {
      context.scope.close();
    }
  });
});
