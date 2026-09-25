import { describe, expect, it } from 'vitest';

import type { AuthorityAtBoundary } from '@orcaops/core';

import { authorityReport } from './database-pre-pr-pass.js';

const findings: AuthorityAtBoundary = {
  boundary: 412,
  artifact_id: 'artifact-1',
  plan_event_id: 'plan-event-1',
  moved: [
    {
      key: 'requirement:offline',
      target: { kind: 'requirement', entity_id: 'offline' },
      artifact_id: 'artifact-1',
      plan_event_id: 'plan-event-1',
      role: 'implement',
      selection: 'selected_with_plan',
      step_id: 'step-1',
      criterion_id: null,
      selected_revision_id: 'offline-r1',
      governing_revision_ids: ['offline-r2'],
      moved_by: [{ record: 'correction', record_id: 'correction-1', effect: 'replaced' }],
      statement: 'The plan selected requirement:offline@offline-r1, which no longer governs.',
    },
  ],
  revoked: [
    {
      act: {
        kind: 'exception',
        id: 'exception-1',
        scope: { kind: 'project', project_id: 'project-1' },
        attributed_to: 'owner',
        recorded_at: '2026-09-18T10:00:00.000Z',
        write_sequence: 120,
        authority: {
          kind: 'assignment',
          id: 'assignment-1',
          standing: 'revoked',
          reason: 'A revocation reaching its scope ended it.',
          revocations: [
            {
              revocation_id: 'revocation-1',
              revoked_by: 'owner',
              recorded_at: '2026-09-18T11:00:00.000Z',
            },
          ],
        },
      },
      rested_on: {
        kind: 'assignment',
        id: 'assignment-1',
        standing: 'revoked',
        reason: 'A revocation reaching its scope ended it.',
        revocations: [
          {
            revocation_id: 'revocation-1',
            revoked_by: 'owner',
            recorded_at: '2026-09-18T11:00:00.000Z',
          },
        ],
      },
      lifts: 'Open a new assignment.',
      statement: 'The exception exception-1 rests on assignment assignment-1, which is revoked.',
    },
  ],
};

describe('what the pre-PR pass prints about authority', () => {
  it('names the act, what it rested on, who revoked it and what lifts it', () => {
    const report = authorityReport(findings);

    expect(report.revoked).toEqual([
      {
        act: { kind: 'exception', id: 'exception-1' },
        rested_on: { kind: 'assignment', id: 'assignment-1' },
        standing: 'revoked',
        revocations: [
          {
            revocation_id: 'revocation-1',
            revoked_by: 'owner',
            recorded_at: '2026-09-18T11:00:00.000Z',
          },
        ],
        lifts: 'Open a new assignment.',
        statement: 'The exception exception-1 rests on assignment assignment-1, which is revoked.',
      },
    ]);
  });

  it('carries a moved obligation whole, with the boundary it was judged at', () => {
    const report = authorityReport(findings);

    expect(report.boundary).toBe(412);
    expect(report.plan_event_id).toBe('plan-event-1');
    expect(report.moved).toEqual(findings.moved);
  });
});
