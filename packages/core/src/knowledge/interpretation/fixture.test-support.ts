import {
  canonicalJson,
  interpretationSegmentId,
  interpretationUnitId,
  prepareInterpretationText,
  type ScheduledInterpretationSegment,
} from '@orcaops/storage';

import { byteLength, sha256Hex } from './bytes.js';
import { ARTIFACT } from './evaluation/knowledge.js';
import {
  buildInterpretationManifest,
  type CoverageLimit,
  type InterpretationManifest,
  type RelatedKnowledge,
  type TaskContext,
} from './manifest.js';
import type {
  InterpretationProposal,
  ProposedAlternative,
  ProposedCitation,
  ProposedLink,
  ProposedStatement,
} from './proposal.js';
import { INTERPRETATION_DETECTOR, PROPOSAL_SCHEMA_VERSION } from './versions.js';

export const SOURCE_RECORDED_AT = '2026-03-28T14:02:00.000Z';
export const PROCESSED_AT = '2026-04-02T09:15:00.000Z';
export const TEST_EVENT_ID = 'event-under-test';
export const TEST_SOURCE_ID = `${TEST_EVENT_ID}#summary#0`;

function segmentFor(input: {
  source_id: string;
  text: string;
  field_path?: string;
  purpose?: ScheduledInterpretationSegment['purpose'];
  role?: ScheduledInterpretationSegment['role'];
  artifact_id?: string;
}): ScheduledInterpretationSegment {
  const prepared = prepareInterpretationText(input.text);
  const occurrence = {
    kind: 'capture_field' as const,
    artifact_id: input.artifact_id ?? ARTIFACT.artifact_id,
    event_id: TEST_EVENT_ID,
    field_path: input.field_path ?? 'summary',
    position: 0,
  };
  const prepared_range = { start: 0, end: byteLength(prepared.prepared) };
  const identity = {
    source_id: input.source_id,
    occurrence,
    role: input.role ?? 'observation',
    purpose: input.purpose ?? 'primary',
    original_sha256: prepared.originalSha256,
    prepared_sha256: prepared.preparedSha256,
    mapping_version: prepared.mappingVersion,
    mapping_sha256: prepared.mappingSha256,
    prepared_range,
    mapping: [...prepared.mapping],
  };
  return { segment_id: interpretationSegmentId(identity), ...identity };
}

export function manifestFor(input: {
  text: string;
  source_id?: string;
  task_context?: TaskContext | null;
  related?: readonly RelatedKnowledge[];
  attributed_to?: InterpretationManifest['attributed_to'];
  coverage_limits?: readonly CoverageLimit[];
  primary_role?: ScheduledInterpretationSegment['role'];
  additional_sources?: readonly {
    source_id: string;
    text: string;
    field_path: string;
    purpose?: ScheduledInterpretationSegment['purpose'];
    role?: ScheduledInterpretationSegment['role'];
    artifact_id?: string;
  }[];
}): InterpretationManifest {
  const sourceId = input.source_id ?? TEST_SOURCE_ID;
  const sourceInputs = [
    { source_id: sourceId, text: input.text },
    ...(input.additional_sources ?? []).map((source) => ({
      source_id: source.source_id,
      text: source.text,
    })),
  ];
  const segments = [
    segmentFor({ source_id: sourceId, text: input.text, role: input.primary_role }),
    ...(input.additional_sources ?? []).map((source) =>
      segmentFor({
        source_id: source.source_id,
        text: source.text,
        field_path: source.field_path,
        purpose: source.purpose,
        role: source.role,
        artifact_id: source.artifact_id,
      })
    ),
  ];
  return buildInterpretationManifest({
    schedule_id: sha256Hex(canonicalJson(segments)),
    unit_id: interpretationUnitId(segments),
    project_id: 'project-under-test',
    source_event_id: TEST_EVENT_ID,
    task_context:
      input.task_context === undefined
        ? { artifact_id: ARTIFACT.artifact_id, plan_event_id: 'event-plan-revision-3' }
        : input.task_context,
    sources: sourceInputs,
    segments,
    attributed_to: input.attributed_to ?? {
      kind: 'detector',
      detector: INTERPRETATION_DETECTOR,
    },
    knowledge_boundary: 412,
    related_knowledge: input.related ?? [],
    ...(input.coverage_limits === undefined ? {} : { coverage_limits: input.coverage_limits }),
  });
}

export function quoteOf(
  manifest: InterpretationManifest,
  quote: string,
  sourceRef = 's1'
): ProposedCitation {
  const segment = manifest.segments.find(
    (candidate) => candidate.source_ref === sourceRef && candidate.text.includes(quote)
  );
  if (segment === undefined) throw new Error(`the fixture quote is not in ${sourceRef}: ${quote}`);
  return { source_ref: sourceRef, segment_ref: segment.ref, quote };
}

export function statementOf(input: {
  manifest: InterpretationManifest;
  wording: string;
  quote?: string;
  source_ref?: string;
  source_form?: ProposedStatement['source_form'];
  proposed_record?: ProposedStatement['proposed_record'];
  intended_scope?: ProposedStatement['intended_scope'];
  rationale?: { wording: string; quote: string; source_ref?: string } | null;
  alternatives?: readonly ProposedAlternative[];
  links?: readonly ProposedLink[];
  evidence?: readonly ProposedCitation[];
}): ProposedStatement {
  const sourceRef = input.source_ref ?? 's1';
  return {
    source_ref: sourceRef,
    wording: input.wording,
    source_form: input.source_form ?? 'stated_obligation',
    proposed_record: input.proposed_record ?? 'requirement',
    intended_scope: input.intended_scope ?? { kind: 'current_task' },
    evidence: [
      ...(input.evidence ?? [quoteOf(input.manifest, input.quote ?? input.wording, sourceRef)]),
    ],
    rationale:
      input.rationale === undefined || input.rationale === null
        ? { kind: 'unknown' }
        : {
            kind: 'stated',
            wording: input.rationale.wording,
            citations: [
              quoteOf(
                input.manifest,
                input.rationale.quote,
                input.rationale.source_ref ?? sourceRef
              ),
            ],
          },
    alternatives: [...(input.alternatives ?? [])],
    links: [...(input.links ?? [])],
  };
}

export function proposalOf(
  manifest: InterpretationManifest,
  parts: Partial<Omit<InterpretationProposal, 'proposal_schema_version' | 'manifest_sha256'>> = {}
): InterpretationProposal {
  return {
    proposal_schema_version: PROPOSAL_SCHEMA_VERSION,
    manifest_sha256: manifest.manifest_sha256,
    statements: parts.statements ?? [],
    corrections: parts.corrections ?? [],
    uncertainties: parts.uncertainties ?? [],
  };
}
