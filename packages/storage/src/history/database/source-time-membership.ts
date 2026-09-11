import { isDeepStrictEqual } from 'node:util';

import type { ArtifactThread } from '../../events/artifact-thread.js';
import { projectArtifactSearchSources } from '../search-content/sources.js';
import type { ArtifactSourceTimeMember } from '../source-time.js';
import { ProjectDatabaseError } from './errors.js';

function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}
export function sourceMembership(
  thread: ArtifactThread,
  member: ArtifactSourceTimeMember,
  historical: boolean
): void {
  const origin = thread.plan?.origin;
  if (origin?.kind !== 'git-import')
    invalid('Source chronology requires the original imported artifact membership');
  const original = origin.member_shas;
  if (original === undefined && !historical)
    invalid(
      'Original artifact commit membership is unavailable; preserve the seed preparation for explicit repair'
    );
  if (
    original !== undefined &&
    !isDeepStrictEqual([...new Set(original)].sort(), member.member_commits)
  )
    invalid('Source chronology cannot change the original artifact commit membership');
  const sources = new Map(
    projectArtifactSearchSources({ projectId: 'membership', thread, artifactGeneration: 1 }).map(
      (source) => [source.source_id, source]
    )
  );
  for (const source of member.sources) {
    const retained = sources.get(source.source_id);
    if (!retained) invalid('Chronology source ID does not belong to the exact retained artifact');
    if (
      ['plan', 'summary', 'digest'].includes(retained.source_kind) &&
      !isDeepStrictEqual(source.attributed_commits, member.member_commits)
    )
      invalid('Plan, summary and digest chronology must retain the complete original member set');
  }
}
export function assertSourceTimeArtifactMembership(
  thread: ArtifactThread,
  member: ArtifactSourceTimeMember | null
): void {
  if (member === null) return;
  try {
    sourceMembership(thread, member, true);
  } catch (cause) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Artifact content cannot retarget retained source chronology membership or identities',
      { cause }
    );
  }
}
