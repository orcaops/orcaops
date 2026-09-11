import { canonicalJson } from '../../events/canonical-json.js';
import { digest } from '../event-integrity.js';
import type { ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  assertCheckoutPinHash,
  CheckoutExpectedSchema,
  CheckoutPayloadSchema,
  CheckoutResultSchema,
} from './execution-checkout-input.js';
import { projectFocusScopeJson } from './execution-focus-input.js';
import type { ProjectOperation } from './transactions.js';

const owners = `SELECT operation_id,target_json,payload_json,payload_hash,expected_state_json,result_json FROM operations
  WHERE operation_kind='execution.checkout' AND json_extract(payload_json,'$.focus.operationId')=? LIMIT 2`;
function conflict(): never {
  throw new ProjectDatabaseError(
    'IDEMPOTENCY_CONFLICT',
    'The original checkout owns this focus operation identity; replay only its exact retained focus request'
  );
}
export function assertNewCheckoutFocusIdentity(
  view: ProjectReadView,
  parentId: string,
  focusId: string
): void {
  if (
    parentId === focusId ||
    view.get('SELECT operation_id FROM operations WHERE operation_id=?', focusId) ||
    view.get(
      'SELECT original_operation_id FROM git_retention_operations WHERE original_operation_id=?',
      focusId
    ) ||
    view.get('SELECT push_id FROM artifact_push_requests WHERE terminal_operation_id=?', focusId) ||
    view.get(owners, focusId)
  )
    conflict();
}
export function assertCheckoutChildOperation(
  view: ProjectReadView,
  operation: ProjectOperation
): void {
  const found = view.all<{
    operation_id: string;
    payload_json: string;
    payload_hash: string;
    target_json: string;
    expected_state_json: string;
    result_json: string;
  }>(owners, operation.operationId);
  if (!found.length) return;
  if (found.length !== 1)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Multiple original checkout receipts claim one focus identity; preserve history for explicit repair'
    );
  let expected: ProjectOperation;
  try {
    const payload = CheckoutPayloadSchema.parse(JSON.parse(found[0]!.payload_json));
    const prior = CheckoutExpectedSchema.parse(JSON.parse(found[0]!.expected_state_json));
    const result = CheckoutResultSchema.parse(JSON.parse(found[0]!.result_json));
    if (
      result.executionVersion !== prior.version + 1 ||
      result.bindingGeneration !== prior.generation + 1 ||
      result.focusOperationId !== payload.focus.operationId ||
      digest(found[0]!.payload_json) !== found[0]!.payload_hash ||
      found[0]!.target_json !== canonicalJson({ artifactId: result.artifactId }) ||
      found[0]!.operation_id === payload.focus.operationId
    )
      throw new Error('Original checkout result differs');
    assertCheckoutPinHash({ artifactId: result.artifactId, payload, expected: prior });
    expected = {
      operationId: payload.focus.operationId,
      kind: 'execution.focus',
      intentChange: false,
      target: { scopeHash: digest(projectFocusScopeJson(payload.focus.scope)) },
      payload: { action: 'set', pinHash: payload.focus.pinHash },
      expectedState: {
        selection: payload.focus.expectedSelection,
        target: {
          artifactId: result.artifactId,
          revision: { ...prior.revision },
          executionVersion: result.executionVersion,
          bindingGeneration: result.bindingGeneration,
        },
      },
    };
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The original checkout focus ownership recipe is invalid; preserve history for explicit repair',
      { cause }
    );
  }
  if (canonicalJson(operation) !== canonicalJson(expected)) conflict();
}
