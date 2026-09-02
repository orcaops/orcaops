import { describe, expect, it } from 'vitest';

import {
  BranchDigestInputError,
  buildBranchDigestData,
  renderBranchDigestMarkdown,
} from './branch.js';
import type { DigestData } from './builder.js';

function digest(
  id: string,
  label: string,
  outcome: string | null,
  overrides: Partial<DigestData> = {}
): DigestData {
  return {
    artifact_id: id,
    label,
    outcome,
    is_complete: outcome !== null,
    started_at: `2026-01-0${id === 'primary' ? '1' : '2'}T00:00:00.000Z`,
    base_sha: 'base',
    origin: null,
    checkpoints: [],
    decisions: [],
    open_items: [],
    deferred_decisions: [],
    open_uncertainty: [],
    uncompleted_steps: [],
    tests_run: [],
    tests_written: [],
    release_checks: [],
    process_notes: [],
    policy_exceptions: [],
    acknowledged_blocks: [],
    ...overrides,
  } as unknown as DigestData;
}

const range = {
  branch: 'feature',
  base: 'origin/main',
  base_sha: 'base',
  merge_base: 'merge-base',
  head_sha: 'head',
  commit_count: 3,
};

describe('buildBranchDigestData', () => {
  it('uses the earliest summarized artifact and retains follow-up evidence', () => {
    const primary = digest('primary', 'Ship the feature', 'The feature shipped.', {
      checkpoints: [
        {
          n: 1,
          ts: '2026-01-01T01:00:00.000Z',
          summary: 'Built the feature.',
          files_changed: ['feature.ts'],
          verification: [{ command: 'pnpm test', exit_code: 0, output_digest: '10 passed' }],
        },
      ],
      decisions: [{ decision: 'Use polling', reason: 'Simple', source: 'plan', revision_n: 0 }],
      open_items: ['Document rollout'],
      tests_run: ['pnpm test'],
      usage: {
        has_usage: true,
        sessions: [
          {
            agent: 'codex',
            session_id: 'shared',
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 20,
            record_count: 1,
          },
        ],
        attributed_estimate: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 20,
        },
      },
    });
    const followUp = digest('follow-up', 'Cache missing IDs', 'Missing IDs are now cached.', {
      checkpoints: [
        {
          n: 1,
          ts: '2026-01-02T01:00:00.000Z',
          summary: 'Added the cache.',
          files_changed: ['cache.ts'],
          verification: [
            { command: ' pnpm   test ', exit_code: 0, output_digest: '12 passed' },
            { command: 'pnpm lint', exit_code: 1, output_digest: 'one error' },
          ],
        },
      ],
      decisions: [
        {
          decision: ' use polling ',
          reason: 'Still simplest',
          source: 'checkpoint',
          checkpoint: 1,
        },
      ],
      open_items: ['document rollout'],
      usage: {
        has_usage: true,
        sessions: [
          {
            agent: 'codex',
            session_id: 'shared',
            input_tokens: 20,
            output_tokens: 7,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 30,
            record_count: 2,
          },
        ],
        attributed_estimate: {
          input_tokens: 20,
          output_tokens: 7,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 30,
        },
      },
    });
    const data = buildBranchDigestData({
      range,
      artifacts: [
        { data: followUp, state: 'summarized', order: 2, anchors: [], matched_anchors: [] },
        { data: primary, state: 'summarized', order: 1, anchors: [], matched_anchors: [] },
      ],
    });

    expect(data.title).toMatchObject({
      text: 'Ship the feature',
      source_artifact_id: 'primary',
      selection_rule: 'earliest_summarized_artifact',
    });
    expect(data.outcome).toContain('Follow-up (Cache missing IDs): Missing IDs are now cached.');
    expect(data.changes.map((change) => change.summary)).toEqual([
      'Built the feature.',
      'Added the cache.',
    ]);
    expect(data.decisions).toHaveLength(2);
    expect(data.decisions.map((decision) => decision.reason)).toEqual(['Simple', 'Still simplest']);
    expect(data.decisions.every((decision) => decision.sources.length === 1)).toBe(true);
    expect(data.open_items).toEqual([
      {
        text: 'Document rollout',
        kind: 'open_item',
        sources: [{ artifact_id: 'primary' }, { artifact_id: 'follow-up' }],
      },
    ]);
    expect(
      data.tests.filter((test) => test.kind === 'verification' && test.exit_code === 0)
    ).toEqual([
      expect.objectContaining({
        output_digest: '12 passed',
        exit_code: 0,
        sources: expect.arrayContaining([
          { artifact_id: 'primary', checkpoint: 1 },
          { artifact_id: 'follow-up', checkpoint: 1 },
        ]),
      }),
    ]);
    expect(data.tests).toContainEqual(expect.objectContaining({ text: 'pnpm lint', exit_code: 1 }));
    expect(data.usage.sessions).toEqual([
      expect.objectContaining({ session_id: 'shared', input_tokens: 20, record_count: 2 }),
    ]);
  });

  it('merges sources only for fully equivalent decisions and passing release checks', () => {
    const releaseCheck = {
      evaluator_ref: 'core/step-coverage',
      phase: 'pre-pr' as const,
      severity: 'block' as const,
      status: 'pass' as const,
      body: 'PASS',
      ts: '2026-01-01T00:00:00.000Z',
    };
    const first = digest('primary', 'First', 'First done.', {
      decisions: [{ decision: 'Use polling', reason: 'Simple', source: 'plan', revision_n: 0 }],
      release_checks: [releaseCheck],
    });
    const second = digest('follow-up', 'Second', 'Second done.', {
      decisions: [
        {
          decision: ' use   polling ',
          reason: ' simple ',
          source: 'checkpoint',
          checkpoint: 1,
        },
      ],
      release_checks: [{ ...releaseCheck, ts: '2026-01-02T00:00:00.000Z' }],
    });

    const data = buildBranchDigestData({
      range,
      artifacts: [
        { data: first, state: 'summarized', order: 1, anchors: [], matched_anchors: [] },
        { data: second, state: 'summarized', order: 2, anchors: [], matched_anchors: [] },
      ],
    });

    expect(data.decisions).toHaveLength(1);
    expect(data.decisions[0].sources).toEqual([
      { artifact_id: 'primary', revision_n: 0 },
      { artifact_id: 'follow-up', checkpoint: 1 },
    ]);
    expect(data.release_checks).toEqual([
      expect.objectContaining({
        ts: '2026-01-02T00:00:00.000Z',
        sources: [
          { artifact_id: 'primary', evaluator_ref: 'core/step-coverage' },
          { artifact_id: 'follow-up', evaluator_ref: 'core/step-coverage' },
        ],
      }),
    ]);
  });

  it('excludes incomplete artifacts from title candidates and validates overrides', () => {
    const incomplete = digest('primary', 'Started with a refactor', null);
    const complete = digest('follow-up', 'Ship the feature', 'Done');
    const artifacts = [
      { data: incomplete, state: 'active', order: 1, anchors: [], matched_anchors: [] },
      { data: complete, state: 'summarized', order: 2, anchors: [], matched_anchors: [] },
    ];
    const data = buildBranchDigestData({ range, artifacts, primaryArtifactId: 'follow-up' });
    expect(data.title_candidates.map((candidate) => candidate.artifact_id)).toEqual(['follow-up']);
    expect(data.incomplete_artifact_ids).toEqual(['primary']);
    expect(data.title?.selection_rule).toBe('explicit_primary_artifact');
    expect(() => buildBranchDigestData({ range, artifacts, primaryArtifactId: 'primary' })).toThrow(
      BranchDigestInputError
    );
  });

  it('renders test kinds, imported provenance, and unreadable artifacts distinctly', () => {
    const imported = digest('primary', 'Imported change', 'Imported outcome.', {
      origin: {
        kind: 'git-import',
        imported_at: '2026-01-01T00:00:00.000Z',
        tool_version: '0.0.0',
        source_range: 'main~1..main',
        authors: ['Ada Example'],
        enriched_at: null,
      },
      checkpoints: [
        {
          n: 1,
          ts: '2026-01-01T00:00:00.000Z',
          summary: 'Imported the change.',
          files_changed: ['feature.ts'],
          verification: [{ command: 'pnpm test', exit_code: 0 }],
        },
      ],
      tests_run: ['pnpm lint'],
      tests_written: ['feature.test.ts'],
    });
    const data = buildBranchDigestData({
      range,
      artifacts: [
        { data: imported, state: 'summarized', order: 1, anchors: [], matched_anchors: [] },
      ],
      excludedArtifacts: [{ id: 'branch-candidate', reason: 'unverifiable' }],
      unreadableArtifacts: [{ id: 'unreadable-repository-artifact', reason: 'unverifiable' }],
    });

    const markdown = renderBranchDigestMarkdown(data);
    expect(markdown).toContain('**Verification:** `pnpm test`');
    expect(markdown).toContain('**Test run:** `pnpm lint`');
    expect(markdown).toContain('**Test file:** `feature.test.ts`');
    expect(markdown).toContain('Imported from Git history (synthesized, not captured reasoning)');
    expect(markdown).toContain('## artifacts not included');
    expect(markdown).toContain('`branch-candidate`');
    expect(markdown).toContain('## unreadable artifacts');
    expect(markdown).toContain('`unreadable-repository-artifact`');
  });
});
