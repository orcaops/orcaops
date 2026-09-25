import { isDeepStrictEqual } from 'node:util';

import {
  authorityAtBoundary,
  type RetainedAuthorityFindings,
  retainedAuthorityFindings,
} from '@orcaops/core';
import { ProjectDatabaseError, type ProjectReadView } from '@orcaops/storage/history/database';

import { readIntegrationAuthorityAtView } from './integration-authority-facts.js';

export function assertIntegrationPublication(
  view: ProjectReadView,
  input: {
    projectId: string;
    artifactId: string;
    command: string;
    expected?: RetainedAuthorityFindings;
    allowMoved?: boolean;
  }
): void {
  const read = readIntegrationAuthorityAtView(view, input);
  if (read === null) return;
  const findings = authorityAtBoundary(read.facts, {
    artifactId: input.artifactId,
    planEventId: read.planEventId,
    boundary: 'now',
    judgedAt: read.judgedAt,
    actingIdentity: read.actingIdentity,
  });
  if (findings.revoked.length > 0)
    throw new ProjectDatabaseError(
      'AUTHORITY_REVOKED',
      `Cannot run ${input.command}: authority no longer stands. ` +
        findings.revoked.map((entry) => `${entry.statement} ${entry.lifts}`).join(' ')
    );
  if (
    input.expected !== undefined &&
    !isDeepStrictEqual(retainedAuthorityFindings(findings), input.expected)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'The integration authority changed after review. Re-run finish.'
    );
  if (findings.moved.length > 0 && !input.allowMoved)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'The selected obligations moved. Update the recorded uses or revise the plan, then re-run finish.'
    );
}
