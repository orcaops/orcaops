import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPlanSearchContent } from './search-content.js';
import { Store } from './sqlite.js';

const basePlan = {
  label: 'throttle charge endpoint',
  task: 'add rate limiting',
  plan_steps: [{ text: 'step one' }, { text: 'step two' }],
  non_goals: [] as Array<{ text: string }>,
  decisions: [] as Array<{
    decision: string;
    reason: string;
    alternatives_considered?: Array<{ option: string; rejected_because: string }>;
    evidence?: { kind: 'git-commit'; commit_sha: string; quote: string };
  }>,
};

describe('buildPlanSearchContent', () => {
  it('leads with the plan label so intent-level wording is searchable', () => {
    expect(buildPlanSearchContent(basePlan)).toBe(
      'throttle charge endpoint · add rate limiting · step one · step two'
    );
  });

  it('appends non-goals only when present', () => {
    expect(
      buildPlanSearchContent({ ...basePlan, non_goals: [{ text: 'no schema migration' }] })
    ).toBe(
      'throttle charge endpoint · add rate limiting · step one · step two · ' +
        'non-goals: no schema migration'
    );
  });

  it('appends decision, reason, and each rejected alternative when decisions are present', () => {
    const content = buildPlanSearchContent({
      ...basePlan,
      decisions: [
        {
          decision: 'use a slidingwindow limiter',
          reason: 'smooths burst-at-boundary',
          alternatives_considered: [
            { option: 'fixedwindow counter', rejected_because: 'allows a boundary burst' },
          ],
          evidence: {
            kind: 'git-commit',
            commit_sha: 'a'.repeat(40),
            quote: 'switch to a sliding window',
          },
        },
      ],
    });
    expect(content).toContain('decisions: use a slidingwindow limiter — smooths burst-at-boundary');
    expect(content).toContain('fixedwindow counter: allows a boundary burst');
    expect(content).toContain(`evidence: commit ${'a'.repeat(40)} — switch to a sliding window`);
  });
});

describe('plan decisions are searchable', () => {
  let tmpRoot: string;
  let store: Store;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-search-decisions-'));
    store = new Store(path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db'));
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'a-1',
      branch: 'main',
      task: 'add rate limiting',
      agent: 'claude-code',
      base_sha: 'sha-base',
      started_at: '2026-04-27T10:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('finds an artifact by a decision wording and by a rejected alternative', () => {
    store.replaceSearchEntry({
      artifact_id: 'a-1',
      source: 'plan:0',
      branch: 'main',
      ts: '2026-04-27T10:00:00.000Z',
      content: buildPlanSearchContent({
        ...basePlan,
        decisions: [
          {
            decision: 'use a slidingwindow limiter',
            reason: 'smooths burst-at-boundary',
            alternatives_considered: [
              { option: 'fixedwindow counter', rejected_because: 'allows a boundary burst' },
            ],
          },
        ],
      }),
    });
    expect(store.search('slidingwindow').map((r) => r.artifact_id)).toContain('a-1');
    expect(store.search('fixedwindow').map((r) => r.artifact_id)).toContain('a-1');
  });
});
