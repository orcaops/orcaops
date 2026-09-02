import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { artifactPathsFor } from './paths.js';
import { ArtifactStore } from './store.js';
import { canonicalJson } from '../events/canonical-json.js';
import { type Config, getDefaultConfig } from '../schema/config.js';

/**
 * Capture summary supersede. A bare re-summary is refused
 * (SUMMARY_ALREADY_CAPTURED) so a second agent can't silently clobber the
 * reviewer-facing record; an explicit prior_summary_event_id token supersedes;
 * a stale token fails STALE_SUMMARY; a same-key retry still replays.
 */
describe('writeSummary — supersede gate', () => {
  let repo: TempRepo;
  let config: Config;
  let store: ArtifactStore;
  const artifactId = '01999999-9999-7000-8000-0000000000f3';

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: repo.path, config });
    await store.writePlan(
      {
        schema_version: 4,
        artifact_id: artifactId,
        branch: 'feat/x',
        base_sha: 'abc123',
        agent: 'claude-code',
        agent_session_id: null,
        task: 'summary supersede fixture',
        label: 'sum-supersede',
        plan_steps: [
          {
            step_id: '01HX0K8N6ZQF8M5R2V8DZ7T3KX',
            text: 's1',
            label: 's1',
            acceptance_criteria: [],
          },
        ],
        touched_scope: [],
        non_goals: [],
        decisions: [],
        started_at: '2026-04-26T12:00:00.000Z',
        revision_n: 0,
        revised_at: null,
        rationale: null,
        step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
        criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
        prior_plan_event_id: null,
      },
      { idempotencyKey: 'plan-sum' }
    );
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  const summaryInput = (overrides: Record<string, unknown> = {}) => ({
    schema_version: 1 as const,
    artifact_id: artifactId,
    outcome: 'shipped',
    tests_written: [],
    tests_run: [],
    open_items: [],
    deferred_decisions: [],
    head_sha: 'sha-sum',
    ts: '2026-04-26T13:00:00.000Z',
    ...overrides,
  });

  async function writeSummaryWithAcceptedWarnings() {
    const runIds = ['run-warning-a', 'run-warning-b'];
    for (const [index, runId] of runIds.entries()) {
      await store.writeEvaluatorRunPayload(
        artifactId,
        {
          schema: 'orcaops.evaluator_run/v1',
          run_id: runId,
          artifact_id: artifactId,
          evaluator_ref: `test/warning-${index}`,
          package_id: 'test',
          evaluator_id: `warning-${index}`,
          phase: 'pre-pr',
          severity: 'warn',
          run_status: 'completed',
          verdict: 'violation',
          body: `warning ${index}`,
          ts: '2026-04-26T12:55:00.000Z',
        },
        { idempotencyKey: `warning-run-${index}` }
      );
    }
    const review = await store.writePrePrChecked(artifactId, {
      head_sha: 'sha-sum',
      outcome: 'needs_attention',
      evaluator_set_fingerprint: 'a'.repeat(64),
      review_context_fingerprint: 'b'.repeat(64),
      run_ids: runIds,
    });
    const acceptedWarnings = runIds.map((runId, index) => ({
      review_id: review.event_id,
      run_id: runId,
      evaluator_ref: `test/warning-${index}`,
      reason: `reviewed warning ${index}`,
    }));
    const summary = await store.writeSummary(
      summaryInput({ accepted_warnings: acceptedWarnings }),
      { idempotencyKey: 'accepted-summary' }
    );
    return { summary, acceptedWarnings };
  }

  it('the first summary succeeds and returns its event_id', async () => {
    const res = await store.writeSummary(summaryInput(), { idempotencyKey: 'sum-1' });
    expect(res.outcome).toBe('created');
    expect(res.event_id).toBeTruthy();
  });

  it('a bare second summary (fresh key, no token) is refused SUMMARY_ALREADY_CAPTURED', async () => {
    const first = await store.writeSummary(summaryInput(), { idempotencyKey: 'sum-2a' });
    await expect(
      store.writeSummary(summaryInput({ outcome: 'clobber' }), { idempotencyKey: 'sum-2b' })
    ).rejects.toMatchObject({ code: 'SUMMARY_ALREADY_CAPTURED', summaryEventId: first.event_id });
  });

  it('a correct prior_summary_event_id supersedes (latest wins)', async () => {
    const first = await store.writeSummary(summaryInput({ outcome: 'first' }), {
      idempotencyKey: 'sum-3a',
    });
    const second = await store.writeSummary(summaryInput({ outcome: 'amended' }), {
      idempotencyKey: 'sum-3b',
      priorSummaryEventId: first.event_id,
    });
    expect(second.outcome).toBe('created');
    const projected = await store.readSummary(artifactId);
    expect(projected?.outcome).toBe('amended');
  });

  it('allows an amendment to repeat accepted warnings in a different order', async () => {
    const { summary, acceptedWarnings } = await writeSummaryWithAcceptedWarnings();
    await store.writePrePrChecked(artifactId, {
      head_sha: 'sha-sum',
      outcome: 'passed',
      evaluator_set_fingerprint: 'c'.repeat(64),
      review_context_fingerprint: 'd'.repeat(64),
      run_ids: [],
    });

    const amended = await store.writeSummary(
      summaryInput({
        outcome: 'amended wording',
        accepted_warnings: [...acceptedWarnings].reverse(),
      }),
      {
        idempotencyKey: 'accepted-summary-amend',
        priorSummaryEventId: summary.event_id,
      }
    );

    expect(amended.outcome).toBe('created');
    expect(amended.summary.accepted_warnings).toEqual(acceptedWarnings);
  });

  it('rejects adding, removing, or changing accepted warnings on an amendment', async () => {
    const { summary, acceptedWarnings } = await writeSummaryWithAcceptedWarnings();
    const attempts = [
      {
        idempotencyKey: 'accepted-summary-remove-all',
        accepted_warnings: undefined,
      },
      {
        idempotencyKey: 'accepted-summary-remove-one',
        accepted_warnings: acceptedWarnings.slice(0, 1),
      },
      {
        idempotencyKey: 'accepted-summary-change',
        accepted_warnings: [
          { ...acceptedWarnings[0]!, reason: 'a different reason' },
          acceptedWarnings[1]!,
        ],
      },
      {
        idempotencyKey: 'accepted-summary-add',
        accepted_warnings: [
          ...acceptedWarnings,
          {
            review_id: acceptedWarnings[0]!.review_id,
            run_id: 'run-warning-extra',
            evaluator_ref: 'test/warning-extra',
            reason: 'an added acceptance',
          },
        ],
      },
    ];

    for (const attempt of attempts) {
      await expect(
        store.writeSummary(
          summaryInput({
            outcome: 'amended wording',
            accepted_warnings: attempt.accepted_warnings,
          }),
          {
            idempotencyKey: attempt.idempotencyKey,
            priorSummaryEventId: summary.event_id,
          }
        )
      ).rejects.toMatchObject({ code: 'WARNING_ACCEPTANCE_INVALID' });
    }
  });

  it('a stale prior_summary_event_id is refused STALE_SUMMARY', async () => {
    await store.writeSummary(summaryInput(), { idempotencyKey: 'sum-4a' });
    await expect(
      store.writeSummary(summaryInput({ outcome: 'x' }), {
        idempotencyKey: 'sum-4b',
        priorSummaryEventId: 'not-the-latest-event-id',
      })
    ).rejects.toMatchObject({ code: 'STALE_SUMMARY' });
  });

  // The same-key retry → replay path (which returns BEFORE this gate) exercises
  // the CLI's replayPayload/extractReplayShape machinery, so it is covered
  // end-to-end in the CLI's tests/integration/summary-supersede.test.ts rather than storage-direct.

  // ── head_sha is inherited on supersede, never restamped ──────────────
  //
  // Callers derive head_sha from CURRENT HEAD, so a supersede taken after later
  // commits would silently move the recorded window: an artifact reviewed at one
  // commit would claim a head it never saw, retroactively widening its scope to
  // work it never covered. Enforced in the store rather than the CLI so a
  // storage-direct caller cannot widen it either.

  it('a supersede inherits the prior head_sha and ignores the one it was handed', async () => {
    const first = await store.writeSummary(summaryInput({ head_sha: 'head-A' }), {
      idempotencyKey: 'sum-head-1a',
    });
    await store.writeSummary(summaryInput({ outcome: 'amended', head_sha: 'head-B' }), {
      idempotencyKey: 'sum-head-1b',
      priorSummaryEventId: first.event_id,
    });

    const projected = await store.readSummary(artifactId);
    // The amendment's content lands...
    expect(projected?.outcome).toBe('amended');
    // ...but the window it records does not move.
    expect(projected?.head_sha).toBe('head-A');
  });

  it('a first capture still records the head_sha it is given', async () => {
    await store.writeSummary(summaryInput({ head_sha: 'head-first' }), {
      idempotencyKey: 'sum-head-2',
    });
    const projected = await store.readSummary(artifactId);
    expect(projected?.head_sha).toBe('head-first');
  });

  it('refuses to amend when the superseded payload fails SummarySchema, rather than restamping', async () => {
    const first = await store.writeSummary(summaryInput({ head_sha: 'head-A' }), {
      idempotencyKey: 'sum-head-malformed',
    });

    // Make the stored summary event unreadable while keeping its checksum valid,
    // recomputing exactly as the log does. Naive tampering would be rejected by
    // the checksum before reaching the guard, so it would test the wrong thing.
    // A checksum-valid, schema-invalid record is the realistic case: a future
    // required field on SummarySchema leaves every older event in exactly this
    // state, and the guard has to hold then too.
    const paths = artifactPathsFor(repo.path, config, artifactId);
    const lines = (await readFile(paths.eventsNdjson, 'utf8')).split('\n').filter(Boolean);
    const rewritten = lines.map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type !== 'summary_captured') return line;
      const payload = record.payload as Record<string, unknown>;
      delete payload.head_sha;
      const { checksum: _drop, ...rest } = record;
      return JSON.stringify({
        ...rest,
        checksum: createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex'),
      });
    });
    await writeFile(paths.eventsNdjson, `${rewritten.join('\n')}\n`, 'utf8');

    const fresh = new ArtifactStore({ repoRoot: repo.path, config });
    try {
      await expect(
        fresh.writeSummary(summaryInput({ outcome: 'amended', head_sha: 'head-CURRENT' }), {
          idempotencyKey: 'sum-head-malformed-2',
          priorSummaryEventId: first.event_id,
        })
      ).rejects.toThrow(/does not satisfy SummarySchema/);

      // And it refused rather than half-writing: no second summary event landed,
      // so head-CURRENT never entered the log.
      const after = (await readFile(paths.eventsNdjson, 'utf8')).split('\n').filter(Boolean);
      const summaryEvents = after.filter(
        (line) => (JSON.parse(line) as { type?: string }).type === 'summary_captured'
      );
      expect(summaryEvents).toHaveLength(1);
      expect(after.join('\n')).not.toContain('head-CURRENT');
    } finally {
      fresh.close();
    }
  });

  it('head_sha survives a chain of supersedes, not just the first one', async () => {
    let latest = await store.writeSummary(summaryInput({ head_sha: 'head-origin' }), {
      idempotencyKey: 'sum-head-3a',
    });
    for (const [i, head] of ['head-drift-1', 'head-drift-2', 'head-drift-3'].entries()) {
      latest = await store.writeSummary(summaryInput({ outcome: `amend-${i}`, head_sha: head }), {
        idempotencyKey: `sum-head-3-${i}`,
        priorSummaryEventId: latest.event_id,
      });
    }
    const projected = await store.readSummary(artifactId);
    expect(projected?.outcome).toBe('amend-2');
    // Each supersede inherits from the one it replaces, so the original head
    // transits the whole chain rather than decaying to the second-newest.
    expect(projected?.head_sha).toBe('head-origin');
  });
});
