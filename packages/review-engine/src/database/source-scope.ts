import path from 'node:path';
import { z } from 'zod';

import {
  type DatabaseHistoryScope,
  HistoryScopeError,
  resolveDatabaseHistoryScope,
} from '@orcaops/project-scope/history/database';
import { HistoryError } from '@orcaops/storage/history/authority';
import {
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
} from '@orcaops/storage/history/database';

import { authoritySchema, revisionId, text, validate } from './request.js';
import { observeDatabaseReviewSourceVersions } from './source-versions.js';

const requestSchema = z.strictObject({
  authority: authoritySchema.omit({ repositoryInstanceId: true }),
  repositoryInstanceId: authoritySchema.shape.repositoryInstanceId.nullable(),
  checkoutRoot: text.nullable(),
  branch: text.refine((value) => Boolean(value.trim()) && !/[\0\r\n]/u.test(value)),
});
export type ReadScopedReviewSourceVersions = z.infer<typeof requestSchema>;

export async function readScopedReviewSourceVersions(raw: ReadScopedReviewSourceVersions) {
  const input = validate(requestSchema, raw);
  const scope = await resolveDatabaseHistoryScope({
    root: input.authority.resolvedRoot,
    cwd: input.checkoutRoot ?? input.authority.resolvedRoot,
    ...(input.checkoutRoot === null ? { gitContext: null } : {}),
    selector: { projectId: input.authority.projectId },
    profile: 'exact',
  });
  let primary: unknown;
  try {
    const project = scope.projects[0];
    if (!scope.completeness.complete || !project?.database || !project.authority) {
      const problem = scope.completeness.issues[0];
      throw new HistoryScopeError(
        problem?.code ?? 'HISTORY_MISSING',
        problem?.message ??
          'Expected review project history is unavailable; preserve it for explicit repair',
        { issues: scope.completeness.issues }
      );
    }
    const authority = project.authority;
    if (authority.storeInstanceId !== input.authority.storeInstanceId)
      throw new ProjectDatabaseError(
        'HISTORY_MISSING',
        'The original review store instance is missing; preserve expected history for explicit repair'
      );
    if (
      Object.entries(input.authority).some(
        ([key, value]) => authority[key as keyof typeof authority] !== value
      ) ||
      (input.repositoryInstanceId !== null &&
        input.repositoryInstanceId !== authority.repositoryInstanceId)
    )
      throw new ProjectDatabaseError(
        'AUTHORITY_MISMATCH',
        'The review identity differs from the selected initialized project; use its original authority'
      );
    if (
      input.checkoutRoot !== null &&
      scope.gitContext?.repositoryInstanceId !== authority.repositoryInstanceId
    )
      throw new HistoryScopeError(
        'REVIEW_CONTEXT_MISMATCH',
        'The supplied review checkout lacks the matching original project registration; select its registered checkout or an explicit outside-Git read'
      );
    return observeDatabaseReviewSourceVersions(project.database, input.branch);
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    closeDatabaseReviewScope(scope, primary);
  }
}

const authorityRequest = z.strictObject({
  cwd: text.optional(),
  dataRoot: text.optional(),
  projectId: revisionId.optional(),
  env: z.record(z.string(), z.string().optional()).optional(),
});

/**
 * The project authority alone, with no review selection and no artifact read.
 *
 * Receipt-first replay needs an authority before it is allowed to select
 * anything, so the receipt lookup can precede every selection, read and Git
 * observation the verb would otherwise do first.
 */
export async function resolveDatabaseReviewAuthority(
  raw: z.infer<typeof authorityRequest>
): Promise<ProjectDatabaseAuthority> {
  const request = validate(authorityRequest, raw);
  const scope = await resolveDatabaseHistoryScope({
    cwd: path.resolve(request.cwd ?? process.cwd()),
    root: request.dataRoot,
    env: { ...(request.env ?? process.env) },
    selector: request.projectId ? { projectId: request.projectId } : {},
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
    return { ...project.authority };
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    closeDatabaseReviewScope(scope, primary);
  }
}

export function closeDatabaseReviewScope(scope: DatabaseHistoryScope, primary: unknown): void {
  try {
    scope.close();
  } catch (closing) {
    const cause =
      primary === undefined
        ? closing
        : new AggregateError(
            [primary, closing],
            'Review source inspection and reader cleanup failed'
          );
    if (primary instanceof ProjectDatabaseError)
      throw new ProjectDatabaseError(primary.code, primary.message, { cause });
    if (primary instanceof HistoryError)
      throw new HistoryError(primary.code, primary.message, { ...primary.context, cause });
    if (primary instanceof HistoryScopeError)
      throw new HistoryScopeError(primary.code, primary.message, { ...primary.context, cause });
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'Review source reader cleanup failed; close the affected reader before retrying',
      { cause }
    );
  }
}
