import path from 'node:path';

import { canonicalJson } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';
import { digest } from '@orcaops/storage/history/primitives';

import type { readDatabaseProvenance } from './database-history-provenance.js';
import type { CanonicalWhyOptions } from './history-provenance.js';
import {
  EXPORT_BYTES,
  exportInspection,
  INSPECTION_BYTES,
  inspectionBytes,
  inspectionValueBytes,
  measuredInspection,
} from './inspection-output.js';
import { getInvocationCwd } from './invocation-context.js';
import { candidateSectionIndex, selectCandidateSection } from './provenance-candidate-sections.js';
import { rationaleIssueSummary, textPreview } from './provenance-output.js';

type Provenance = Awaited<ReturnType<typeof readDatabaseProvenance>>;

export function provenanceInspectionAnchor(result: Provenance) {
  return `why1.${digest(
    canonicalJson({
      scope: {
        kind: result.scope.kind,
        root_key: result.scope.root_key,
        authorities: result.scope.authorities,
        worktree_id: result.scope.worktree_id,
        branch: result.scope.branch.value,
      },
      target: result.target,
      filters: result.filters,
      code_revision: result.code_revision,
      boundary: result.rationale.boundary,
      observation: result.rationale.observation,
      generation: result.project_coverage.generation_token,
      sources: result.source_versions,
    })
  )}`;
}

export async function inspectProvenanceCandidate(result: Provenance, options: CanonicalWhyOptions) {
  if (options.anchor !== provenanceInspectionAnchor(result))
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The target, query scope, code, or history observation changed. Repeat bounded why discovery and select a returned candidate.'
    );
  if (!result.selected_candidate)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'The selected candidate is not in this bounded provenance result. Repeat discovery.'
    );
  const auditSelection = {
    candidate_id: options.candidate!,
    anchor: options.anchor,
    target: {
      file: result.target.file,
      line: result.target.line,
      content_hash: result.target.content_hash,
    },
    scope: result.scope,
    code_revision: result.code_revision,
    historical_boundary: result.rationale.boundary,
    observation_ceiling: result.rationale.observation,
  };
  const selection = options.output
    ? auditSelection
    : {
        candidate_id: options.candidate!,
        anchor: options.anchor,
        project_id: result.scope.authorities[0]?.project_id,
        mode: 'historical_candidate' as const,
      };
  const sections = candidateSectionIndex(
    result.selected_candidate,
    options.section === 'index' ? options.sectionOffset : undefined,
    options.section === 'index' ? options.sectionLimit : undefined
  );
  const selected =
    options.section && options.section !== 'index'
      ? selectCandidateSection(result.selected_candidate, options)
      : null;
  const content = {
    schema_version: 8 as const,
    representation: 'candidate' as const,
    status: selected?.content === null ? ('unavailable' as const) : ('available' as const),
    selection,
    conclusion: result.conclusion,
    ...(selected
      ? {
          section: selected.section,
          ...(selected.decision === undefined ? {} : { decision: selected.decision }),
          content: selected.content,
          qualifications: {
            scope: 'selected_candidate_fields_only',
            checkpoint_uncertainty: {
              entries: result.selected_candidate.checkpoint?.uncertainty.length ?? null,
              inspect: '--section uncertainty',
            },
          },
        }
      : options.section === 'index'
        ? { sections }
        : { candidate: result.selected_candidate }),
    completeness: {
      ...result.completeness,
      issues: rationaleIssueSummary(result.completeness.issues),
    },
    uncertainty: result.uncertainty,
  };
  if (options.output) {
    const receipt = {
      schema_version: 8 as const,
      representation: 'candidate_export' as const,
      selection,
      file: { path: path.resolve(getInvocationCwd(), options.output), bytes: EXPORT_BYTES },
    };
    measuredInspection(receipt);
    return measuredInspection({
      ...receipt,
      file: await exportInspection(options.output, content),
    });
  }
  if (selected && Array.isArray(selected.content) && selected.decision === undefined) {
    const offset = options.sectionOffset ?? 0;
    const limit = options.sectionLimit ?? 5;
    if (offset > selected.content.length)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Candidate section offset exceeds its entry count'
      );
    const page = {
      ...content,
      content: [] as Array<{
        position: number;
        status: string;
        content?: unknown;
        content_bytes?: number;
        wording?: ReturnType<typeof textPreview>;
        preview_only?: true;
        inspect?: string;
      }>,
      pagination: { offset, total: selected.content.length, next_offset: null as number | null },
    };
    for (let index = offset; index < Math.min(selected.content.length, offset + limit); index++) {
      const value = selected.content[index];
      const entry = { position: index + 1, status: 'available', content: value };
      page.content.push(entry);
      if (
        inspectionBytes({
          ...page,
          pagination: { ...page.pagination, next_offset: selected.content.length },
          output: { ceiling_bytes: INSPECTION_BYTES, bytes: INSPECTION_BYTES },
        }) > INSPECTION_BYTES
      ) {
        page.content.pop();
        if (page.content.length) break;
        page.content.push({
          position: index + 1,
          status: 'omitted_oversized',
          content_bytes: inspectionValueBytes(value),
          ...(typeof value === 'object' && 'decision' in value
            ? { wording: textPreview(value.decision), preview_only: true as const }
            : {}),
          inspect: `--section ${selected.section} ${selected.section.endsWith('decisions') ? `--decision ${index + 1}` : `--section-offset ${index} --section-limit 1`}`,
        });
      }
    }
    const next = offset + page.content.length;
    page.pagination.next_offset = next < selected.content.length ? next : null;
    return measuredInspection(page);
  }
  if (
    inspectionBytes({
      ...content,
      output: { ceiling_bytes: INSPECTION_BYTES, bytes: INSPECTION_BYTES },
    }) <= INSPECTION_BYTES
  )
    return measuredInspection(content);
  return measuredInspection({
    schema_version: 8 as const,
    representation: 'candidate' as const,
    status: 'omitted_oversized' as const,
    selection,
    conclusion: result.conclusion,
    ...(selected
      ? { section: selected.section, decision: selected.decision, content: null }
      : { candidate: null }),
    sections,
    content_bytes: inspectionBytes(content),
    reason: `The ${selected ? 'selected historical section' : 'complete historical candidate'} exceeds the display allowance. No checkpoint, decision, or qualification was clipped.`,
    follow_up:
      'Preserve target, scope, candidate and anchor. Inspect a listed --section, page arrays with --section-offset/--section-limit, or select one decision with --decision <n>. Use --output <new-file.json> only when the complete selected unit is required.',
  });
}
