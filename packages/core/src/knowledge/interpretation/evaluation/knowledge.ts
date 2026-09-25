import type {
  AuthorityScope,
  Designation,
  KnowledgeInterpretation,
  RecordRevisionRef,
  RelationshipStanding,
  ResolvedKnowledge,
  RevisionStanding,
  SourceStanding,
} from '@orcaops/storage';

import { byteLength, type ByteSpan } from '../bytes.js';
import type { RelatedKnowledge } from '../manifest.js';

export const PROJECT = {
  kind: 'project',
  project_id: 'project-inspection-app',
} as const satisfies AuthorityScope;
export const ARTIFACT = {
  kind: 'artifact',
  artifact_id: 'artifact-offline-sync',
} as const satisfies AuthorityScope;
export const KNOWLEDGE_BOUNDARY = 412;
export const PROCESSED_AT = '2026-04-02T09:15:00.000Z';

/** When the set's sources were recorded, which is what every record they publish keeps. */
export const SOURCE_RECORDED_AT = '2026-03-28T14:02:00.000Z';

export interface ExistingRevision {
  kind: 'requirement' | 'decision' | 'claim' | 'relationship';
  entity_id: string;
  revision_id: string;
  text: string;
  standing?: RevisionStanding['standing'];
  designation?: Designation | null;
  source_standing?: SourceStanding;
  scope?: AuthorityScope;
  intended_scope?: KnowledgeInterpretation['intended_scope'];
  intended_scope_status?: 'legacy_absent' | 'verified' | 'invalid';
  selection_ids?: readonly string[];
  /** An established replacement this revision already makes. */
  supersedes?: RecordRevisionRef;
}

/** The byte span of `quote` inside `text`. Throws so a fixture typo fails loudly. */
export function spanOf(text: string, quote: string, nth = 1): ByteSpan {
  let index = -1;
  for (let occurrence = 0; occurrence < nth; occurrence += 1) {
    index = text.indexOf(quote, index + 1);
    if (index < 0)
      throw new Error(
        `the fixture quote is not in its source ${nth} times: ${JSON.stringify(quote)}`
      );
  }
  const start = byteLength(text.slice(0, index));
  return { start, end: start + byteLength(quote) };
}

/**
 * One resolver answer about one identity, as the worker would have read it.
 * Hand-built rather than computed: the manifest freezes whatever the resolver
 * returned, and these cases are about what happens after it did.
 */
export function existingKnowledge(input: ExistingRevision): RelatedKnowledge {
  const revision: RecordRevisionRef = {
    kind: input.kind,
    entity_id: input.entity_id,
    revision_id: input.revision_id,
  };
  const scope = input.scope ?? PROJECT;
  const standing: RevisionStanding = {
    revision,
    standing: input.standing ?? 'stands',
    scope: input.standing === 'unadopted' ? null : scope,
    designation: input.designation ?? 'adopted',
    applicability: 'applies',
    source_standing: input.source_standing ?? 'explicit_instruction',
    attributed_to: { kind: 'actor', actor: { identity: 'owner', basis: 'authenticated' } },
    challenged_by: [],
    account_corrected_by: [],
    corrected_basis: [],
    authority_revoked_by: [],
    departed_in_scope: [],
    in_replacement_cycle: false,
    stood_by: [...(input.selection_ids ?? [`selection-${input.revision_id}`])],
    because: [],
  };
  const relationships: RelationshipStanding[] =
    input.supersedes === undefined
      ? []
      : [
          {
            relationship_id: `relationship-${input.revision_id}-supersedes`,
            relation: 'supersedes',
            from: revision,
            to: input.supersedes,
            scope,
            attributed_to: { kind: 'actor', actor: { identity: 'owner', basis: 'authenticated' } },
            standing: 'established',
            applied: true,
            not_applied: null,
            authority_revoked_by: [],
            because: [],
          },
        ];
  const resolved: ResolvedKnowledge = {
    target: { kind: input.kind, entity_id: input.entity_id },
    basis: {
      scope,
      mode: 'current',
      knowledge_boundary: KNOWLEDGE_BOUNDARY,
      implementation: { kind: 'none_selected' },
      applicability: {},
      exceptions_judged_at: null,
    },
    revisions: [standing],
    governing_state: {
      selection_ids: [...(input.selection_ids ?? [`selection-${input.revision_id}`])],
      correction_action_ids: [],
    },
    conflicts: [],
    proposals: [],
    selection_effects: (input.selection_ids ?? [`selection-${input.revision_id}`]).map(
      (selection_id) => ({ selection_id, standing: 'effective' })
    ),
    correction_effects: [],
    relationships,
    recorded_choices: [],
    exceptions: [],
    branch_scoped: [],
    later_annotations: [],
    omissions: [],
    unresolved: [],
    evidence: { kind: 'not_attached' },
  };
  return {
    resolved,
    statements: [
      {
        revision,
        text: input.text,
        ...(input.intended_scope === undefined ? {} : { intended_scope: input.intended_scope }),
        intended_scope_status:
          input.intended_scope_status ??
          (input.intended_scope === undefined ? 'legacy_absent' : 'verified'),
      },
    ],
  };
}
