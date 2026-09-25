import {
  type Attribution,
  type AuthorityScope,
  canonicalJson,
  type Designation,
  interpretationUnitId,
  type KnowledgeInterpretation,
  prepareInterpretationText,
  type RecordRevisionRef,
  type ResolvedKnowledge,
  type RevisionStanding,
  type ScheduledInterpretationSegment,
  ScheduledInterpretationSegmentSchema,
  type SourceStanding,
} from '@orcaops/storage';

import { sha256Hex, sourceBytes, textAt } from './bytes.js';
import { INSTRUCTIONS_SHA256 } from './instructions.js';
import { PROCESSOR_CONTRACT, PROMPT_VERSION, PROPOSAL_SCHEMA_VERSION } from './versions.js';

export const MANIFEST_VERSION = 3;

export interface TaskContext {
  artifact_id: string;
  plan_event_id: string;
}

export interface InterpretationSource {
  ref: string;
  source_id: string;
  occurrence: ScheduledInterpretationSegment['occurrence'];
}

export interface InterpretationSegment extends ScheduledInterpretationSegment {
  ref: string;
  source_ref: string;
  /** Exactly the safe prepared bytes in `prepared_range`, and nothing outside the unit. */
  text: string;
}

export interface ManifestKnowledgeEntry {
  ref: string;
  resolved: ResolvedKnowledge;
}

export interface ManifestRevisionEntry {
  ref: string;
  entry_ref: string;
  revision: RecordRevisionRef;
  standing: RevisionStanding['standing'];
  designation: Designation | null;
  source_standing: SourceStanding | null;
  attributed_to: Attribution | null;
  statement: string;
  intended_scope: KnowledgeInterpretation['intended_scope'] | null;
  intended_scope_status: 'legacy_absent' | 'verified' | 'invalid';
  adopted_scope: AuthorityScope | null;
}

export type CoverageLimitKind =
  | 'related_knowledge_truncated'
  | 'access_restricted_omitted'
  | 'related_statement_missing'
  | 'retrieval_limit'
  | 'source_context_missing';

export interface CoverageLimit {
  kind: CoverageLimitKind;
  detail: string;
}

export interface InterpretationManifest {
  manifest_version: number;
  processor_contract: string;
  prompt_version: string;
  proposal_schema_version: string;
  attributed_to: Attribution;
  schedule_id: string;
  unit_id: string;
  project_id: string;
  source_event_id: string;
  task_context: TaskContext | null;
  sources: readonly InterpretationSource[];
  segments: readonly InterpretationSegment[];
  knowledge_boundary: number;
  related_knowledge: readonly ManifestKnowledgeEntry[];
  revisions: readonly ManifestRevisionEntry[];
  coverage_limits: readonly CoverageLimit[];
  instructions_sha256: string;
  manifest_sha256: string;
}

export interface RelatedKnowledge {
  resolved: ResolvedKnowledge;
  statements: readonly {
    revision: RecordRevisionRef;
    text: string;
    intended_scope?: KnowledgeInterpretation['intended_scope'];
    intended_scope_status?: 'legacy_absent' | 'verified' | 'invalid';
  }[];
}

export interface ManifestSourceInput {
  source_id: string;
  /** The immutable retained projection before deterministic cleaning and redaction. */
  text: string;
}

export interface ManifestInput {
  schedule_id: string;
  unit_id: string;
  project_id: string;
  source_event_id: string;
  task_context: TaskContext | null;
  sources: readonly ManifestSourceInput[];
  segments: readonly ScheduledInterpretationSegment[];
  attributed_to: Attribution;
  knowledge_boundary: number;
  related_knowledge: readonly RelatedKnowledge[];
  coverage_limits?: readonly CoverageLimit[];
}

const revisionKey = (ref: RecordRevisionRef) =>
  JSON.stringify([ref.kind, ref.entity_id, ref.revision_id]);

export function buildInterpretationManifest(input: ManifestInput): InterpretationManifest {
  const suppliedSources = new Map<string, ReturnType<typeof prepareInterpretationText>>();
  for (const source of input.sources) {
    if (suppliedSources.has(source.source_id)) {
      throw new Error(`source ${source.source_id} appears more than once in the manifest input`);
    }
    suppliedSources.set(source.source_id, prepareInterpretationText(source.text));
  }
  const sourceRefs = new Map<string, string>();
  const sources: InterpretationSource[] = [];
  const segments: InterpretationSegment[] = [];
  const scheduledSegments: ScheduledInterpretationSegment[] = [];
  const segmentIds = new Set<string>();

  for (const [index, supplied] of input.segments.entries()) {
    const parsed = ScheduledInterpretationSegmentSchema.safeParse(supplied);
    if (!parsed.success) {
      throw new Error(
        `invalid scheduled segment ${index}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      );
    }
    const segment = parsed.data;
    scheduledSegments.push(segment);
    if (segment.occurrence.event_id !== input.source_event_id) {
      throw new Error(`segment ${segment.segment_id} belongs to another source event`);
    }
    const prepared = suppliedSources.get(segment.source_id);
    if (prepared === undefined) {
      throw new Error(`segment ${segment.segment_id} names an unsupplied source`);
    }
    if (
      segment.original_sha256 !== prepared.originalSha256 ||
      segment.prepared_sha256 !== prepared.preparedSha256 ||
      segment.mapping_version !== prepared.mappingVersion ||
      segment.mapping_sha256 !== prepared.mappingSha256 ||
      canonicalJson(segment.mapping) !== canonicalJson(prepared.mapping)
    ) {
      throw new Error(`segment ${segment.segment_id} does not match deterministic preparation`);
    }
    const text = textAt(sourceBytes(prepared.prepared), segment.prepared_range);
    if (text === null) {
      throw new Error(`segment ${segment.segment_id} range is outside its prepared source`);
    }
    if (segmentIds.has(segment.segment_id)) {
      throw new Error(`segment ${segment.segment_id} appears more than once in the unit`);
    }
    segmentIds.add(segment.segment_id);

    let ref = sourceRefs.get(segment.source_id);
    if (ref === undefined) {
      ref = `s${sourceRefs.size + 1}`;
      sourceRefs.set(segment.source_id, ref);
      sources.push({ ref, source_id: segment.source_id, occurrence: segment.occurrence });
    } else {
      const source = sources.find((candidate) => candidate.ref === ref);
      if (canonicalJson(source?.occurrence) !== canonicalJson(segment.occurrence)) {
        throw new Error(`source ${segment.source_id} has conflicting occurrences in one unit`);
      }
    }
    segments.push({ ...segment, ref: `g${index + 1}`, source_ref: ref, text });
  }
  if (input.unit_id !== interpretationUnitId(scheduledSegments)) {
    throw new Error('unit ID does not match its exact ordered scheduled segments');
  }

  const entries: ManifestKnowledgeEntry[] = [];
  const revisions: ManifestRevisionEntry[] = [];
  const coverage: CoverageLimit[] = [...(input.coverage_limits ?? [])];
  input.related_knowledge.forEach((related, entryIndex) => {
    const entryRef = `k${entryIndex + 1}`;
    entries.push({ ref: entryRef, resolved: related.resolved });
    const wording = new Map(
      related.statements.map((statement) => [revisionKey(statement.revision), statement.text])
    );
    const interpretationScopes = new Map(
      related.statements.map((statement) => [
        revisionKey(statement.revision),
        {
          intended_scope: statement.intended_scope ?? null,
          intended_scope_status: statement.intended_scope_status ?? 'invalid',
        },
      ])
    );
    related.resolved.revisions.forEach((standing, revisionIndex) => {
      const statement = wording.get(revisionKey(standing.revision));
      if (statement === undefined) {
        coverage.push({
          kind: 'related_statement_missing',
          detail: `${standing.revision.kind} revision ${standing.revision.revision_id} was left out: its wording was not retained.`,
        });
        return;
      }
      const interpretationScope = interpretationScopes.get(revisionKey(standing.revision));
      revisions.push({
        ref: `${entryRef}r${revisionIndex + 1}`,
        entry_ref: entryRef,
        revision: standing.revision,
        standing: standing.standing,
        designation: standing.designation,
        source_standing: standing.source_standing,
        attributed_to: standing.attributed_to,
        statement,
        intended_scope: interpretationScope?.intended_scope ?? null,
        intended_scope_status: interpretationScope?.intended_scope_status ?? 'invalid',
        adopted_scope: standing.scope,
      });
    });
  });

  return sealed({
    manifest_version: MANIFEST_VERSION,
    processor_contract: PROCESSOR_CONTRACT,
    prompt_version: PROMPT_VERSION,
    proposal_schema_version: PROPOSAL_SCHEMA_VERSION,
    attributed_to: input.attributed_to,
    schedule_id: input.schedule_id,
    unit_id: input.unit_id,
    project_id: input.project_id,
    source_event_id: input.source_event_id,
    task_context: input.task_context,
    sources,
    segments,
    knowledge_boundary: input.knowledge_boundary,
    related_knowledge: entries,
    revisions,
    coverage_limits: coverage,
    instructions_sha256: INSTRUCTIONS_SHA256,
  });
}

export function manifestHash(manifest: Omit<InterpretationManifest, 'manifest_sha256'>): string {
  return sha256Hex(canonicalJson(manifest));
}

function sealed(manifest: Omit<InterpretationManifest, 'manifest_sha256'>): InterpretationManifest {
  return { ...manifest, manifest_sha256: manifestHash(manifest) };
}

export function manifestRevision(
  manifest: InterpretationManifest,
  ref: string
): ManifestRevisionEntry | null {
  return manifest.revisions.find((entry) => entry.ref === ref) ?? null;
}

export function manifestSource(
  manifest: InterpretationManifest,
  ref: string
): InterpretationSource | null {
  return manifest.sources.find((source) => source.ref === ref) ?? null;
}

export function manifestSegment(
  manifest: InterpretationManifest,
  sourceRef: string,
  segmentRef: string
): InterpretationSegment | null {
  return (
    manifest.segments.find(
      (segment) => segment.source_ref === sourceRef && segment.ref === segmentRef
    ) ?? null
  );
}
