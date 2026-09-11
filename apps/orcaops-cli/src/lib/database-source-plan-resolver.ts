import { PullCacheRecordSchema } from '@orcaops/storage';
import {
  type ProjectDatabase,
  scanProjectApprovedSourcePlans,
} from '@orcaops/storage/history/database';

import type { SourcePlanLookup } from './source-plan-resolver.js';

export function databaseSourcePlanLookup(handle: ProjectDatabase): SourcePlanLookup {
  return async (externalId, approvedVersion) =>
    scanProjectApprovedSourcePlans(handle, { externalId, approvedVersion }).matches.map(
      ({ record }) => ({
        record: PullCacheRecordSchema.parse(
          JSON.parse(Buffer.from(record.recordBase64, 'base64').toString('utf8'))
        ),
        namespace: record.namespace.namespaceId,
      })
    );
}
