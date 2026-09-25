// Resolving an approved source selector to a local identity, preserving its binding exactly.
//
// The approver saw a passage, so what receives the approved standing is that passage verbatim: the
// binding, the revision the selector resolves to and the statement that revision makes are all
// read from the store, and the contract judges them. Nothing here decides whether a paraphrase
// preserves meaning, so a paraphrase is a later proposed revision and never the resolution.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { requireStoreScope } from './knowledge-authority.js';
import {
  AlreadyRetained,
  authoredRecord,
  committedNothing,
  integrity,
  invalid,
  missing,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  publishUnlessRetained,
  replayOperation,
  retriedOperation,
  secretAllowList,
} from './knowledge-record-input.js';
import { scopeColumns } from './knowledge-standing.js';
import {
  ApprovalBindingSchema,
  checkSelectorResolution,
  DecisionRevisionSchema,
  type RecordRevisionRef,
  RequirementRevisionSchema,
  type ResolutionRefusal,
  type SelectorResolution,
  SelectorResolutionSchema,
} from '../../schema/knowledge-contract.js';
import { digest } from '../event-integrity.js';

export interface PublishSelectorResolution {
  readonly operationId: string;
  /** The resolution as authored. A selector resolves to an identity; nobody is named by it. */
  readonly resolution: unknown;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type SelectorResolutionPublication = {
  bindingId: string;
  resolvedRevisionId: string;
  recordSha256: string;
  /** False when this exact resolution was already retained, which this call returned unwritten. */
  published: boolean;
};

const RESOLUTION_REFUSAL: Record<ResolutionRefusal, string> = {
  SELECTOR_NOT_BOUND:
    'The approval bound no such selector in this scope with this designation; a resolution preserves its binding and never broadens it',
  RESOLVED_REVISION_NOT_FROM_PASSAGE:
    'The revision this selector resolves to does not cite the approved passage',
  RESOLVED_STATEMENT_NOT_VERBATIM:
    'The revision this selector resolves to does not state the approved passage verbatim; a paraphrase is a later proposed revision',
  SELECTOR_ALREADY_RESOLVED:
    'That passage already resolved to another identity; publish a revision of that identity instead',
};

/** The statement a revision makes, and the passages it restates, as the contract judges them. */
function resolvedRevision(
  view: ProjectReadView,
  ref: RecordRevisionRef
): {
  passages: { source_id: string; location: string; passage_sha256: string }[];
  statement_sha256: string;
} {
  if (ref.kind !== 'requirement' && ref.kind !== 'decision')
    invalid('A source selector resolves to a requirement or a decision revision');
  const table = ref.kind === 'requirement' ? 'requirement_revisions' : 'decision_revisions';
  const column = ref.kind === 'requirement' ? 'requirement_id' : 'decision_id';
  const row = view.get<{ payload: string }>(
    `SELECT CAST(record_bytes AS TEXT) AS payload FROM ${table} WHERE ${column}=? AND revision_id=?`,
    ref.entity_id,
    ref.revision_id
  );
  if (row === null)
    missing('The revision this selector resolves to is not retained in this history');
  const parsedRevision =
    ref.kind === 'requirement'
      ? RequirementRevisionSchema.safeParse(JSON.parse(row.payload))
      : DecisionRevisionSchema.safeParse(JSON.parse(row.payload));
  if (!parsedRevision.success)
    integrity(
      'A retained revision does not read as its contract record; preserve history for explicit repair'
    );
  const revision = parsedRevision.data;
  const statement =
    'statement' in revision
      ? revision.statement
      : (revision as { chosen_approach: string }).chosen_approach;
  return { passages: [...revision.passages], statement_sha256: digest(Buffer.from(statement)) };
}

// Every authored field, designation included: a resolution that differs in one of them is a
// different act, and answering it as a repeat would return the other row's hash for it.
const RETAINED = `SELECT record_sha256 FROM selector_resolutions
  WHERE binding_id=? AND selector_source_id=? AND selector_location=? AND selector_passage_sha256=?
    AND resolved_kind=? AND resolved_id=? AND resolved_revision_id=? AND scope_kind=? AND scope_value IS ?
    AND designation=?`;

const retainedResolution = (view: ProjectReadView, resolution: SelectorResolution) => {
  const [scopeKind, scopeValue] = scopeColumns(resolution.scope);
  return view.get<{ record_sha256: string }>(
    RETAINED,
    resolution.binding_id,
    resolution.selector.source_id,
    resolution.selector.location,
    resolution.selector.passage_sha256,
    resolution.resolved.kind,
    resolution.resolved.entity_id,
    resolution.resolved.revision_id,
    scopeKind,
    scopeValue,
    resolution.designation
  );
};

const publication = (
  resolution: SelectorResolution,
  recordSha256: string,
  published: boolean
): SelectorResolutionPublication => ({
  bindingId: resolution.binding_id,
  resolvedRevisionId: resolution.resolved.revision_id,
  recordSha256,
  published,
});

const EXISTING_FOR_PASSAGE = `SELECT binding_id, selector_source_id, selector_location, selector_passage_sha256,
    resolved_kind, resolved_id, resolved_revision_id, scope_kind, scope_value, designation
  FROM selector_resolutions
  WHERE selector_source_id=? AND selector_location=? AND selector_passage_sha256=?`;

function check(
  view: ProjectReadView,
  resolution: SelectorResolution,
  projectId: string
): SelectorResolutionPublication | null {
  const retained = retainedResolution(view, resolution);
  // Nothing ends a resolution and its binding fixes the designation, so a second row could only
  // repeat the first.
  if (retained) return publication(resolution, retained.record_sha256, false);
  const bindingRow = view.get<{ payload: string }>(
    'SELECT CAST(record_bytes AS TEXT) AS payload FROM approval_bindings WHERE binding_id=?',
    resolution.binding_id
  );
  if (bindingRow === null)
    missing('The approval binding this resolution names is not retained in this history');
  const binding = ApprovalBindingSchema.safeParse(JSON.parse(bindingRow.payload));
  if (!binding.success)
    integrity(
      'A retained approval binding does not read as its contract record; preserve history for explicit repair'
    );
  const existing = view
    .all<{
      binding_id: string;
      selector_source_id: string;
      selector_location: string;
      selector_passage_sha256: string;
      resolved_kind: string;
      resolved_id: string;
      resolved_revision_id: string;
      scope_kind: string;
      scope_value: string | null;
      designation: string;
    }>(
      EXISTING_FOR_PASSAGE,
      resolution.selector.source_id,
      resolution.selector.location,
      resolution.selector.passage_sha256
    )
    .map(
      (row) =>
        ({
          binding_id: row.binding_id,
          selector: {
            source_id: row.selector_source_id,
            location: row.selector_location,
            passage_sha256: row.selector_passage_sha256,
          },
          resolved: {
            kind: row.resolved_kind,
            entity_id: row.resolved_id,
            revision_id: row.resolved_revision_id,
          },
          scope:
            row.scope_kind === 'project'
              ? { kind: 'project', project_id: projectId }
              : { kind: 'artifact', artifact_id: row.scope_value },
          designation: row.designation,
        }) as SelectorResolution
    );
  const outcome = checkSelectorResolution({
    binding: binding.data,
    resolution,
    resolved_revision: resolvedRevision(view, resolution.resolved),
    existing,
  });
  if (!outcome.ok) invalid(RESOLUTION_REFUSAL[outcome.code]);
  return null;
}

export async function publishProjectSelectorResolution(
  handle: ProjectDatabase,
  input: PublishSelectorResolution,
  options: ProjectOperationOptions = {}
) {
  const resolution = parsed(SelectorResolutionSchema, input.resolution, 'A selector resolution');
  const projectId = handle.authority.projectId;
  requireStoreScope(projectId, resolution.scope);
  const record = authoredRecord(resolution, secretAllowList(input.secretAllow));
  const op = {
    operationId: operationIdentity(input.operationId),
    kind: 'knowledge.selector.resolution.publish',
    target: {
      bindingId: resolution.binding_id,
      resolvedRevisionId: resolution.resolved.revision_id,
    },
    payload: { record: record.sha256 },
    expectedState: null,
    // A resolution gives a local identity the standing the approval bound to a passage.
    intentChange: true,
  } as const;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  const retained = handle.read((view) => check(view, resolution, projectId)).value;
  // A resolution the store already holds is not published again, and a call that publishes nothing
  // runs no operation: no receipt, and neither counter moves.
  if (retained) return committedNothing(handle, retained);
  return publishUnlessRetained(
    handle,
    op,
    (transaction: ProjectSettlement, settling): SelectorResolutionPublication => {
      const existing = check(transaction, resolution, projectId);
      if (existing) throw new AlreadyRetained(existing);
      const [scopeKind, scopeValue] = scopeColumns(resolution.scope);
      transaction.run(
        `INSERT INTO selector_resolutions (binding_id, selector_source_id, selector_location,
           selector_passage_sha256, resolved_kind, resolved_id, resolved_revision_id,
           scope_kind, scope_value, designation, record_bytes, record_sha256, operation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        resolution.binding_id,
        resolution.selector.source_id,
        resolution.selector.location,
        resolution.selector.passage_sha256,
        resolution.resolved.kind,
        resolution.resolved.entity_id,
        resolution.resolved.revision_id,
        scopeKind,
        scopeValue,
        resolution.designation,
        record.bytes,
        record.sha256,
        settling.operationId
      );
      return publication(resolution, record.sha256, true);
    },
    options
  );
}

export interface ProjectSelectorResolution {
  readonly bindingId: string;
  readonly selector: { sourceId: string; location: string; passageSha256: string };
  readonly resolved: { kind: string; entityId: string; revisionId: string };
  readonly scope: { kind: string; value: string | null };
  readonly designation: string;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

/** Every resolution of one binding, with every column the writer recorded. */
export function listProjectSelectorResolutions(
  view: ProjectReadView,
  bindingId: string
): ProjectSelectorResolution[] {
  return view
    .all<{
      binding_id: string;
      selector_source_id: string;
      selector_location: string;
      selector_passage_sha256: string;
      resolved_kind: string;
      resolved_id: string;
      resolved_revision_id: string;
      scope_kind: string;
      scope_value: string | null;
      designation: string;
      record_hex: string;
      record_sha256: string;
      operation_id: string;
    }>(
      `SELECT binding_id, selector_source_id, selector_location, selector_passage_sha256, resolved_kind,
         resolved_id, resolved_revision_id, scope_kind, scope_value, designation,
         hex(record_bytes) AS record_hex, record_sha256, operation_id
       FROM selector_resolutions WHERE binding_id=? ORDER BY rowid`,
      bindingId
    )
    .map((row) => ({
      bindingId: row.binding_id,
      selector: {
        sourceId: row.selector_source_id,
        location: row.selector_location,
        passageSha256: row.selector_passage_sha256,
      },
      resolved: {
        kind: row.resolved_kind,
        entityId: row.resolved_id,
        revisionId: row.resolved_revision_id,
      },
      scope: { kind: row.scope_kind, value: row.scope_value },
      designation: row.designation,
      recordHex: row.record_hex,
      recordSha256: row.record_sha256,
      operationId: row.operation_id,
    }));
}
