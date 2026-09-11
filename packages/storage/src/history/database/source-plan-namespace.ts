import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { assertProjectDatabasePath, type ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  decodeRetainedSourcePlanNamespace,
  type SourcePlanNamespace,
} from './source-plan-input.js';
import { sourcePlanIntegrity, sourcePlanNamespaceMissing } from './source-plan-records.js';
import { canonicalizeBaseUrl } from '../../source-plan/canonical-base-url.js';

const scopeSchema = z.strictObject({
  serverUrl: z.string().min(1),
  orgId: z.string().min(1),
  accountId: z.string().min(1),
});
export type ProjectSourcePlanAccountScope = z.infer<typeof scopeSchema>;
export function readProjectSourcePlanNamespace(
  handle: ProjectDatabase,
  input: ProjectSourcePlanAccountScope
): Extract<SourcePlanNamespace, { scopeKind: 'account' }> | null {
  assertProjectDatabasePath(handle);
  let scope: ProjectSourcePlanAccountScope;
  try {
    scope = scopeSchema.parse(input);
    const url = new URL(scope.serverUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error('Invalid account server');
    scope = { ...scope, serverUrl: canonicalizeBaseUrl(scope.serverUrl) };
  } catch (cause) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the exact known server, organization and account namespace; do not infer unknown historical accounts',
      { cause }
    );
  }
  const observed = handle.read((view) => {
    const row = view.get<SourcePlanNamespace>(
      `SELECT namespace_id AS namespaceId,scope_kind AS scopeKind,server_url AS serverUrl,
    org_id AS orgId,account_id AS accountId,original_namespace_hash AS originalNamespaceHash,
    original_locator_hash AS originalLocatorHash FROM source_plan_namespaces
    WHERE scope_kind='account' AND server_url=? AND org_id=? AND account_id=?`,
      scope.serverUrl,
      scope.orgId,
      scope.accountId
    );
    if (row === null && sourcePlanNamespaceMissing(view)) sourcePlanIntegrity();
    return row;
  }).value;
  if (observed === null) return null;
  try {
    const value = decodeRetainedSourcePlanNamespace(observed);
    if (
      value.scopeKind !== 'account' ||
      !isDeepStrictEqual(value, observed) ||
      value.serverUrl !== scope.serverUrl ||
      value.orgId !== scope.orgId ||
      value.accountId !== scope.accountId
    )
      sourcePlanIntegrity();
    return value;
  } catch (cause) {
    sourcePlanIntegrity(cause);
  }
}
