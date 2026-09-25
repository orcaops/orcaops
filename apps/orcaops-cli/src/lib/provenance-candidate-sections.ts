import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import type { readDatabaseProvenance } from './database-history-provenance.js';
import type { CanonicalWhyOptions } from './history-provenance.js';
import { inspectionValueBytes } from './inspection-output.js';

type Candidate = NonNullable<
  Awaited<ReturnType<typeof readDatabaseProvenance>>['selected_candidate']
>;

export function candidateSections(candidate: Candidate) {
  return {
    checkpoint: candidate.checkpoint,
    'checkpoint-metadata': candidate.checkpoint
      ? { n: candidate.checkpoint.n, head_sha: candidate.checkpoint.head_sha }
      : null,
    plan: candidate.plan_support.plan,
    'source-plan': candidate.source_plan,
    'checkpoint-decisions': candidate.checkpoint?.decisions ?? null,
    'plan-decisions': candidate.plan_support.plan?.decisions ?? null,
    uncertainty: candidate.checkpoint?.uncertainty ?? null,
    files: candidate.checkpoint?.files_changed ?? null,
  };
}

export function candidateSectionIndex(candidate: Candidate, offset = 0, limit = 3) {
  if (
    offset >
    Math.max(
      candidate.checkpoint?.decisions.length ?? 0,
      candidate.plan_support.plan?.decisions.length ?? 0
    )
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Decision preview offset exceeds the candidate index'
    );
  return Object.entries(candidateSections(candidate)).map(([section, content]) => ({
    section,
    state: content === null ? 'unavailable' : 'available',
    content_bytes: content === null ? null : inspectionValueBytes(content),
    ...(Array.isArray(content) ? { entries: content.length, paged: true } : {}),
    ...(Array.isArray(content) && section.endsWith('decisions')
      ? {
          previews: content.slice(offset, offset + limit).map((entry, index) => ({
            position: offset + index + 1,
            wording: Array.from(typeof entry === 'string' ? entry : entry.decision)
              .slice(0, 100)
              .join(''),
            preview_only: true,
            content_bytes: inspectionValueBytes(entry),
            inspect: `--section ${section} --decision ${offset + index + 1}`,
          })),
          next_offset: offset + limit < content.length ? offset + limit : null,
        }
      : {}),
    inspect: `--section ${section}`,
  }));
}

export function selectCandidateSection(candidate: Candidate, options: CanonicalWhyOptions) {
  const sections = candidateSections(candidate);
  const section = options.section as keyof typeof sections;
  const content = sections[section];
  if (options.decision !== undefined) {
    if (!Array.isArray(content) || options.decision > content.length)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'The selected candidate decision does not exist'
      );
    return { section, decision: options.decision, content: content[options.decision - 1] };
  }
  return { section, content };
}
