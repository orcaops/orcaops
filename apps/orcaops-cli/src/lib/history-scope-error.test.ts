import { expect, it } from 'vitest';

import { HistoryScopeError } from '@orcaops/project-scope/history';
import { uuidv7 } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { historyScopeCommandError } from './history-scope-error.js';
import { toErrorEnvelope } from '../io/output.js';

it('retains qualified exact candidates without fabricating hydrated capture fields', () => {
  const projectId = uuidv7();
  const artifactId = uuidv7();
  const command = `orcaops show ${artifactId} --project ${projectId}`;
  const error = historyScopeCommandError(
    new HistoryScopeError('AMBIGUOUS_ARTIFACT', 'Select an exact artifact', {
      candidates: [{ project_id: projectId, artifact_id: artifactId, command }],
      truncated: true,
    })
  );
  expect(toErrorEnvelope(error)).toEqual({
    ok: false,
    error: {
      code: 'AMBIGUOUS_ARTIFACT',
      message: 'Select an exact artifact',
      history_candidates: [{ id: artifactId, project_id: projectId, command }],
      truncated: true,
    },
  });
});
it('preserves database errors and their structured failure reason at the public output boundary', () => {
  const error = new ProjectDatabaseError(
    'HISTORY_INACCESSIBLE',
    'Check the original database permissions'
  );
  expect(historyScopeCommandError(error)).toBe(error);
  expect(toErrorEnvelope(historyScopeCommandError(error)).error.code).toBe('HISTORY_INACCESSIBLE');
});
it('preserves a scope failure without promoting malformed candidate context to public fields', () => {
  const result = toErrorEnvelope(
    historyScopeCommandError(
      new HistoryScopeError('AMBIGUOUS_ARTIFACT', 'Select a longer prefix', {
        candidates: [{ label: 'unknown' }],
        truncated: true,
      })
    )
  );
  expect(result).toEqual({
    ok: false,
    error: { code: 'AMBIGUOUS_ARTIFACT', message: 'Select a longer prefix' },
  });
});
