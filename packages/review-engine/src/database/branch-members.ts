import path from 'node:path';
import { z } from 'zod';

import {
  HistoryScopeError,
  resolveDatabaseHistoryScope,
} from '@orcaops/project-scope/history/database';
import {
  type ProjectDatabaseAuthority,
  queryProjectArtifacts,
} from '@orcaops/storage/history/database';

import { invalid, revisionId, text, validate } from './request.js';
import { closeDatabaseReviewScope } from './source-scope.js';

const requestSchema = z.strictObject({
  branch: text.refine((value) => Boolean(value.trim()) && !/[\0\r\n]/u.test(value)),
  projectId: revisionId.optional(),
  cwd: text.optional(),
  dataRoot: text.optional(),
  env: z.record(z.string(), z.string().optional()).optional(),
});
export type ReadDatabaseReviewBranchMembers = z.infer<typeof requestSchema>;
export interface DatabaseReviewBranchMember {
  artifactId: string;
  generation: number;
  orderedHash: string;
}
export interface DatabaseReviewBranchMembers {
  authority: ProjectDatabaseAuthority;
  projectId: string;
  branch: string;
  members: DatabaseReviewBranchMember[];
}

/**
 * The exact retained revision of every artifact the branch reaches, ordered by
 * artifact ID so a membership record's bytes do not depend on query order.
 *
 * The branch is an explicit argument, not the checked-out branch: a review verb
 * is asked for a branch that need not be current. Selection fails closed —
 * an incomplete scope refuses, and `queryProjectArtifacts` raises an integrity
 * error for retained metadata it cannot decode — because a silently narrowed
 * member set would retarget the review at an older tree and drop the artifact
 * from its deliverables.
 */
export async function readDatabaseReviewBranchMembers(
  raw: ReadDatabaseReviewBranchMembers
): Promise<DatabaseReviewBranchMembers> {
  const request = validate(requestSchema, raw);
  const input = {
    ...request,
    cwd: path.resolve(request.cwd ?? process.cwd()),
    env: { ...(request.env ?? process.env) },
  };
  const scope = await resolveDatabaseHistoryScope({
    cwd: input.cwd,
    root: input.dataRoot,
    env: input.env,
    selector: input.projectId ? { projectId: input.projectId } : {},
    profile: 'exact',
  });
  let primary: unknown;
  try {
    const project = scope.projects[0];
    if (!scope.completeness.complete || !project?.database || !project.authority) {
      const issue = scope.completeness.issues[0];
      throw new HistoryScopeError(
        issue?.code ?? 'HISTORY_MISSING',
        issue?.message ??
          'Expected project history is unavailable; preserve it for explicit repair',
        { issues: scope.completeness.issues }
      );
    }
    const selected = queryProjectArtifacts(project.database, {
      branch: input.branch,
      profile: 'versions',
    });
    const members = selected.rows
      .map((row) => ({
        artifactId: row.artifactId,
        generation: row.generation,
        orderedHash: row.orderedHash,
      }))
      .sort((left, right) => (left.artifactId < right.artifactId ? -1 : 1));
    if (new Set(members.map((member) => member.artifactId)).size !== members.length)
      invalid('The branch selection returned one artifact more than once');
    return {
      authority: { ...project.authority },
      projectId: project.projectId,
      branch: input.branch,
      members,
    };
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    closeDatabaseReviewScope(scope, primary);
  }
}
