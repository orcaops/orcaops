import { describe, expect, it } from 'vitest';

import { formatProjectScopeWarnings } from './project-scope.js';

describe('formatProjectScopeWarnings', () => {
  it('discloses an incomplete hot projection with recovery guidance', () => {
    const warning = formatProjectScopeWarnings([
      {
        kind: 'hot_projection_incomplete',
        project_id: '019fc100-0000-7000-8000-00000000aaaa',
        project: 'sample-service',
        health: 'degraded',
        message: 'Local artifact data may be incomplete.',
      },
    ]);

    expect(warning).toContain('Partial project data');
    expect(warning).toContain('[sample-service] Local artifact data may be incomplete.');
    expect(warning).toContain('run `orcaops rebuild`');
  });
});
