// Publishing an approval binding: the approval, the exact targets it bound with their scope and
// designation, and, per scope, exactly the departures the approver was shown.
//
// A bound revision, a bound selector and a named exception reference nothing here: an approval may
// arrive before the store holds the revision it binds, and the exception a binding names is
// published under that binding afterwards. The authorization evidence is a source this store must
// already hold, because it is what the binding rests on.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { requireStoreScope } from './knowledge-authority.js';
import {
  actingField,
  actorColumns,
  authoredRecord,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  replayOperation,
  requireRetainedSources,
  retriedOperation,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import { scopeColumns } from './knowledge-standing.js';
import { runProjectOperation } from './transactions.js';
import {
  type Actor,
  type ApprovalBinding,
  ApprovalBindingSchema,
  bindingCoveredByApproval,
} from '../../schema/knowledge-contract.js';

export interface PublishApprovalBinding {
  readonly operationId: string;
  /** The binding as authored, without `approved_by`. */
  readonly binding: unknown;
  /** Who approved it, which a publishing session will own once storage has one. */
  readonly approvedBy: Actor;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type ApprovalBindingPublication = {
  bindingId: string;
  recordSha256: string;
  targets: number;
  departures: number;
  /** True when an earlier binding of the same approval bound exactly this, so nothing new is bound. */
  inheritsApproval: boolean;
};

const SAME_APPROVAL = `SELECT CAST(record_bytes AS TEXT) AS payload FROM approval_bindings
  WHERE source_plan_ref=? AND approved_version=? AND plan_content_sha256=? AND binding_id<>?`;

/**
 * Whether an earlier binding of this very approval already bound the same targets, scopes,
 * designations and departures. Byte-identical plan text with a changed binding inherits nothing,
 * so a caller that expected an inherited approval can see that it has a new one.
 */
function inheritsApproval(view: ProjectReadView, binding: ApprovalBinding): boolean {
  return view
    .all<{
      payload: string;
    }>(
      SAME_APPROVAL,
      binding.approval.source_plan_ref,
      binding.approval.version,
      binding.approval.plan_content_sha256,
      binding.binding_id
    )
    .some((row) => {
      const prior = ApprovalBindingSchema.safeParse(JSON.parse(row.payload));
      return prior.success && bindingCoveredByApproval(prior.data, binding);
    });
}

function check(view: ProjectReadView, binding: ApprovalBinding): void {
  if (view.get('SELECT binding_id FROM approval_bindings WHERE binding_id=?', binding.binding_id))
    taken('That approval binding ID already belongs to retained history');
  requireRetainedSources(view, [binding.authorization_evidence_source_id]);
}

export async function publishProjectApprovalBinding(
  handle: ProjectDatabase,
  input: PublishApprovalBinding,
  options: ProjectOperationOptions = {}
) {
  const binding = parsed(
    ApprovalBindingSchema,
    actingField(input.binding, 'approved_by', input.approvedBy),
    'An approval binding'
  );
  const projectId = handle.authority.projectId;
  for (const target of binding.targets) requireStoreScope(projectId, target.scope);
  for (const entry of binding.departures) requireStoreScope(projectId, entry.scope);
  const record = authoredRecord(binding, secretAllowList(input.secretAllow));
  const op = {
    operationId: operationIdentity(input.operationId),
    kind: 'knowledge.approval.binding.publish',
    target: {
      bindingId: binding.binding_id,
      sourcePlanRef: binding.approval.source_plan_ref,
      version: binding.approval.version,
    },
    payload: { record: record.sha256 },
    expectedState: null,
    // A binding with targets designates what it bound; a plan approved as a plan adopts nothing.
    intentChange: binding.targets.length > 0,
  } as const;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  handle.read((view) => {
    check(view, binding);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement, settling): ApprovalBindingPublication => {
      check(transaction, binding);
      const [approver, basis] = actorColumns(binding.approved_by);
      transaction.run(
        `INSERT INTO approval_bindings (binding_id, source_plan_ref, approved_version, plan_content_sha256,
           approved_by, approved_by_basis, authorization_evidence_source_id, record_bytes, record_sha256, operation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        binding.binding_id,
        binding.approval.source_plan_ref,
        binding.approval.version,
        binding.approval.plan_content_sha256,
        approver,
        basis,
        binding.authorization_evidence_source_id,
        record.bytes,
        record.sha256,
        settling.operationId
      );
      binding.targets.forEach((target, position) => {
        const [scopeKind, scopeValue] = scopeColumns(target.scope);
        const bound = target.target;
        transaction.run(
          `INSERT INTO approval_binding_targets (binding_id, position, bound_kind, target_kind, target_id,
             target_revision_id, selector_source_id, selector_location, selector_passage_sha256,
             scope_kind, scope_value, designation, operation_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          binding.binding_id,
          position,
          bound.kind,
          bound.kind === 'revision' ? bound.revision.kind : null,
          bound.kind === 'revision' ? bound.revision.entity_id : null,
          bound.kind === 'revision' ? bound.revision.revision_id : null,
          bound.kind === 'source_selector' ? bound.selector.source_id : null,
          bound.kind === 'source_selector' ? bound.selector.location : null,
          bound.kind === 'source_selector' ? bound.selector.passage_sha256 : null,
          scopeKind,
          scopeValue,
          target.designation,
          settling.operationId
        );
      });
      binding.departures.forEach((entry, position) => {
        const [scopeKind, scopeValue] = scopeColumns(entry.scope);
        const { departure } = entry;
        transaction.run(
          `INSERT INTO approval_binding_departures (binding_id, position, scope_kind, scope_value,
             rule_kind, rule_id, rule_revision_id, how, exception_id,
             replaced_by_kind, replaced_by_id, replaced_by_revision_id, operation_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          binding.binding_id,
          position,
          scopeKind,
          scopeValue,
          departure.rule.kind,
          departure.rule.entity_id,
          departure.rule.revision_id,
          departure.how,
          departure.exception_id,
          departure.replaced_by === null ? null : departure.replaced_by.kind,
          departure.replaced_by === null ? null : departure.replaced_by.entity_id,
          departure.replaced_by === null ? null : departure.replaced_by.revision_id,
          settling.operationId
        );
      });
      return {
        bindingId: binding.binding_id,
        recordSha256: record.sha256,
        targets: binding.targets.length,
        departures: binding.departures.length,
        inheritsApproval: inheritsApproval(transaction, binding),
      };
    },
    options
  );
}

export interface ProjectApprovalBindingTarget {
  readonly position: number;
  readonly boundKind: string;
  readonly revision: { kind: string; entityId: string; revisionId: string } | null;
  readonly selector: { sourceId: string; location: string; passageSha256: string } | null;
  readonly scope: { kind: string; value: string | null };
  readonly designation: string;
}

export interface ProjectApprovalBindingDeparture {
  readonly position: number;
  readonly scope: { kind: string; value: string | null };
  readonly rule: { kind: string; entityId: string; revisionId: string };
  readonly how: string;
  readonly exceptionId: string | null;
  readonly replacedBy: { kind: string; entityId: string; revisionId: string } | null;
}

export interface ProjectApprovalBinding {
  readonly bindingId: string;
  readonly approval: { sourcePlanRef: string; version: string; planContentSha256: string };
  readonly approvedBy: { identity: string | null; basis: string };
  readonly authorizationEvidenceSourceId: string;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
  readonly targets: ProjectApprovalBindingTarget[];
  readonly departures: ProjectApprovalBindingDeparture[];
}

export function readProjectApprovalBinding(
  view: ProjectReadView,
  bindingId: string
): ProjectApprovalBinding | null {
  const row = view.get<{
    binding_id: string;
    source_plan_ref: string;
    approved_version: string;
    plan_content_sha256: string;
    approved_by: string | null;
    approved_by_basis: string;
    authorization_evidence_source_id: string;
    record_hex: string;
    record_sha256: string;
    operation_id: string;
  }>(
    `SELECT binding_id, source_plan_ref, approved_version, plan_content_sha256, approved_by, approved_by_basis,
       authorization_evidence_source_id, hex(record_bytes) AS record_hex, record_sha256, operation_id
     FROM approval_bindings WHERE binding_id=?`,
    bindingId
  );
  if (row === null) return null;
  const targets = view
    .all<{
      position: number;
      bound_kind: string;
      target_kind: string | null;
      target_id: string | null;
      target_revision_id: string | null;
      selector_source_id: string | null;
      selector_location: string | null;
      selector_passage_sha256: string | null;
      scope_kind: string;
      scope_value: string | null;
      designation: string;
    }>(
      `SELECT position, bound_kind, target_kind, target_id, target_revision_id, selector_source_id,
         selector_location, selector_passage_sha256, scope_kind, scope_value, designation
       FROM approval_binding_targets WHERE binding_id=? ORDER BY position`,
      bindingId
    )
    .map((target) => ({
      position: target.position,
      boundKind: target.bound_kind,
      revision:
        target.target_kind === null
          ? null
          : {
              kind: target.target_kind,
              entityId: target.target_id as string,
              revisionId: target.target_revision_id as string,
            },
      selector:
        target.selector_source_id === null
          ? null
          : {
              sourceId: target.selector_source_id,
              location: target.selector_location as string,
              passageSha256: target.selector_passage_sha256 as string,
            },
      scope: { kind: target.scope_kind, value: target.scope_value },
      designation: target.designation,
    }));
  const departures = view
    .all<{
      position: number;
      scope_kind: string;
      scope_value: string | null;
      rule_kind: string;
      rule_id: string;
      rule_revision_id: string;
      how: string;
      exception_id: string | null;
      replaced_by_kind: string | null;
      replaced_by_id: string | null;
      replaced_by_revision_id: string | null;
    }>(
      `SELECT position, scope_kind, scope_value, rule_kind, rule_id, rule_revision_id, how, exception_id,
         replaced_by_kind, replaced_by_id, replaced_by_revision_id
       FROM approval_binding_departures WHERE binding_id=? ORDER BY position`,
      bindingId
    )
    .map((departure) => ({
      position: departure.position,
      scope: { kind: departure.scope_kind, value: departure.scope_value },
      rule: {
        kind: departure.rule_kind,
        entityId: departure.rule_id,
        revisionId: departure.rule_revision_id,
      },
      how: departure.how,
      exceptionId: departure.exception_id,
      replacedBy:
        departure.replaced_by_kind === null
          ? null
          : {
              kind: departure.replaced_by_kind,
              entityId: departure.replaced_by_id as string,
              revisionId: departure.replaced_by_revision_id as string,
            },
    }));
  return {
    bindingId: row.binding_id,
    approval: {
      sourcePlanRef: row.source_plan_ref,
      version: row.approved_version,
      planContentSha256: row.plan_content_sha256,
    },
    approvedBy: { identity: row.approved_by, basis: row.approved_by_basis },
    authorizationEvidenceSourceId: row.authorization_evidence_source_id,
    recordHex: row.record_hex,
    recordSha256: row.record_sha256,
    operationId: row.operation_id,
    targets,
    departures,
  };
}
