// What an approval bound at a knowledge boundary, and what became of it.
//
// An approval binds exact targets, each with its scope and designation, and a selector resolution
// answers a bound selector with a local identity. Neither record is ever withdrawn — nothing ends a
// resolution, and a binding is history — so "does it still stand?" is a question about the revision
// each one names, answered from the governing state at this read's boundary. A resolution that was
// bound then and whose revision a later act replaced reads as exactly that: the row is there, and
// the revision does not stand.
//
// A binding's targets and departures are written in the same operation as the binding itself, so
// the binding's own write sequence is the boundary for all three.
import { type ProjectReadView } from './connection.js';
import {
  type ProjectApprovalBinding,
  type ProjectApprovalBindingTarget,
  readProjectApprovalBinding,
} from './knowledge-approval-bindings.js';
import {
  type KnowledgeReadCoverage,
  knowledgeReadCoverage,
  type RevisionGoverningStanding,
  revisionGoverningState,
  writeSequencesOf,
} from './knowledge-read-boundary.js';
import { type GoverningStateReader, governingStateReader } from './knowledge-read-governing.js';
import {
  listProjectSelectorResolutions,
  type ProjectSelectorResolution,
} from './knowledge-selector-resolutions.js';
import type { RecordRevisionRef } from '../../schema/knowledge-contract.js';
import type { KnowledgeReadRequest, RevisionStanding } from '../../schema/knowledge-resolution.js';

export interface ProjectApprovalRef {
  readonly sourcePlanRef: string;
  readonly version: string;
  readonly planContentSha256: string;
}

export interface ProjectBoundTarget {
  readonly target: ProjectApprovalBindingTarget;
  /** `null` for a bound source selector: it names a passage, and no revision until one resolves it. */
  readonly standing: RevisionGoverningStanding | null;
  readonly entries: readonly RevisionStanding[];
}

export interface ProjectResolutionAtBoundary {
  readonly resolution: ProjectSelectorResolution;
  readonly writeSequence: number;
  readonly standing: RevisionGoverningStanding;
  readonly entries: readonly RevisionStanding[];
}

export interface ProjectBindingAtBoundary {
  readonly binding: ProjectApprovalBinding;
  readonly writeSequence: number;
  readonly targets: readonly ProjectBoundTarget[];
  readonly resolutions: readonly ProjectResolutionAtBoundary[];
}

export interface ProjectApprovalAtBoundary {
  readonly approval: ProjectApprovalRef;
  readonly coverage: KnowledgeReadCoverage;
  readonly bindings: readonly ProjectBindingAtBoundary[];
}

const BINDINGS_OF_APPROVAL = `SELECT binding_id, operation_id FROM approval_bindings
  WHERE source_plan_ref=? AND approved_version=? AND plan_content_sha256=?`;

const standingAt = (
  governing: GoverningStateReader,
  revision: { kind: string; entityId: string; revisionId: string }
) =>
  revisionGoverningState(
    governing.at({
      kind: revision.kind as RecordRevisionRef['kind'],
      entity_id: revision.entityId,
    }),
    revision.revisionId
  );

function bindingAt(
  view: ProjectReadView,
  bindingId: string,
  writeSequence: number,
  governing: GoverningStateReader,
  request: KnowledgeReadRequest
): ProjectBindingAtBoundary | null {
  const binding = readProjectApprovalBinding(view, bindingId);
  if (binding === null) return null;
  const resolutions = listProjectSelectorResolutions(view, bindingId);
  const sequences = writeSequencesOf(
    view,
    resolutions.map((resolution) => resolution.operationId)
  );
  return {
    binding,
    writeSequence,
    targets: binding.targets.map((target) => {
      if (target.revision === null) return { target, standing: null, entries: [] };
      const state = standingAt(governing, target.revision);
      return { target, standing: state.standing, entries: state.entries };
    }),
    resolutions: resolutions.flatMap((resolution) => {
      const at = sequences.get(resolution.operationId);
      if (at === undefined || at > request.knowledge_boundary) return [];
      const state = standingAt(governing, resolution.resolved);
      return [{ resolution, writeSequence: at, standing: state.standing, entries: state.entries }];
    }),
  };
}

/** One binding, its bound targets and the resolutions that answered them, at the boundary. */
export function readProjectBindingAtBoundary(
  view: ProjectReadView,
  bindingId: string,
  projectId: string,
  request: KnowledgeReadRequest
): (ProjectBindingAtBoundary & { readonly coverage: KnowledgeReadCoverage }) | null {
  const row = view.get<{ operation_id: string }>(
    'SELECT operation_id FROM approval_bindings WHERE binding_id=?',
    bindingId
  );
  if (row === null) return null;
  const writeSequence = writeSequencesOf(view, [row.operation_id]).get(row.operation_id);
  if (writeSequence === undefined || writeSequence > request.knowledge_boundary) return null;
  const governing = governingStateReader(view, projectId, request);
  const at = bindingAt(view, bindingId, writeSequence, governing, request);
  return at === null
    ? null
    : { ...at, coverage: knowledgeReadCoverage(request, governing.answers()) };
}

/** Every binding of one approval, with what each bound and what became of it. */
export function readProjectApprovalAtBoundary(
  view: ProjectReadView,
  approval: ProjectApprovalRef,
  projectId: string,
  request: KnowledgeReadRequest
): ProjectApprovalAtBoundary {
  const rows = view.all<{ binding_id: string; operation_id: string }>(
    BINDINGS_OF_APPROVAL,
    approval.sourcePlanRef,
    approval.version,
    approval.planContentSha256
  );
  const sequences = writeSequencesOf(
    view,
    rows.map((row) => row.operation_id)
  );
  const governing = governingStateReader(view, projectId, request);
  const bindings = rows.flatMap((row) => {
    const at = sequences.get(row.operation_id);
    if (at === undefined || at > request.knowledge_boundary) return [];
    const binding = bindingAt(view, row.binding_id, at, governing, request);
    return binding === null ? [] : [binding];
  });
  return {
    approval,
    coverage: knowledgeReadCoverage(request, governing.answers()),
    bindings,
  };
}
