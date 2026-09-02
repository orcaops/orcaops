import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '@orcaops/core';
import { ArtifactStore } from '@orcaops/storage';
import { createRepoTemplate, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

/**
 * `capture summary` supersede at the CLI boundary — surfaces
 * summary_event_id, refuses a bare re-summary (SUMMARY_ALREADY_CAPTURED naming
 * the existing event), rejects a stale token (STALE_SUMMARY), and replaces the
 * summary when the correct prior_summary_event_id token is passed.
 */
describe('orcaops capture summary — supersede', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  // `init` is identical for every test here and costs ~450ms; run it once
  // and give each test a ~20ms copy of the result.
  const repoTemplate = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({ cwd: repoPath, env: { ORCAOPS_DISABLE_DRAIN: '1' } }).runRaw([
        'init',
        '--json',
        '--no-llm',
      ]);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await repoTemplate.checkout();
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
  });

  afterAll(async () => {
    await repoTemplate.destroy();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function planAndSummary(): Promise<{ artifactId: string; summaryEventId: string }> {
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'F3ii summary fixture',
          label: `f3ii-${randomUUID().slice(0, 8)}`,
          plan_steps: [{ text: 's1', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const artifactId = (JSON.parse(pr.stdout) as { artifact_id: string }).artifact_id;
    const sr = await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: artifactId,
          outcome: 'first',
        })
      ),
    ]);
    expect(sr.exitCode, sr.stdout).toBe(0);
    const summaryEventId =
      (JSON.parse(sr.stdout) as { summary_event_id?: string }).summary_event_id ?? '';
    expect(summaryEventId).toBeTruthy();
    return { artifactId, summaryEventId };
  }

  const reSummary = (artifactId: string, extra: Record<string, unknown>) =>
    agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: artifactId,
          outcome: 'again',
          ...extra,
        })
      ),
    ]);

  it('surfaces summary_event_id, refuses a bare re-summary, and supersedes with the token', async () => {
    const { artifactId, summaryEventId } = await planAndSummary();

    // bare re-summary → SUMMARY_ALREADY_CAPTURED, message names the event.
    const bare = await reSummary(artifactId, {});
    expect(bare.exitCode).toBe(1);
    const bareErr = JSON.parse(bare.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(bareErr.ok).toBe(false);
    expect(bareErr.error.code).toBe('SUMMARY_ALREADY_CAPTURED');
    expect(bareErr.error.message).toContain(summaryEventId);

    // stale token → STALE_SUMMARY.
    const stale = await reSummary(artifactId, { prior_summary_event_id: 'not-the-latest' });
    expect(stale.exitCode).toBe(1);
    expect((JSON.parse(stale.stdout) as { error: { code: string } }).error.code).toBe(
      'STALE_SUMMARY'
    );

    // correct token → supersedes.
    const amend = await reSummary(artifactId, { prior_summary_event_id: summaryEventId });
    expect(amend.exitCode, amend.stdout).toBe(0);
    expect((JSON.parse(amend.stdout) as { ok: boolean }).ok).toBe(true);
  });

  it('a same-key summary retry replays (not refused by the supersede gate)', async () => {
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'replay fixture',
          label: `replay-${randomUUID().slice(0, 8)}`,
          plan_steps: [{ text: 's1', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const artifactId = (JSON.parse(pr.stdout) as { artifact_id: string }).artifact_id;
    const key = `sum-${randomUUID()}`;
    const payload = JSON.stringify({
      idempotency_key: key,
      artifact_id: artifactId,
      outcome: 'once',
    });
    const s1 = await agent.runRaw(['capture', 'summary', '--input', inputFile(payload)]);
    expect(s1.exitCode, s1.stdout).toBe(0);
    const s2 = await agent.runRaw(['capture', 'summary', '--input', inputFile(payload)]);
    expect(s2.exitCode, s2.stdout).toBe(0);
    expect((JSON.parse(s2.stdout) as { idempotency_status?: string }).idempotency_status).toBe(
      'replay'
    );
  });

  it('finish allows a wording-only amendment after the worktree changes', async () => {
    const plan = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'accepted warning amendment fixture',
          label: `accepted-${randomUUID().slice(0, 8)}`,
          plan_steps: [{ text: 's1', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const artifactId = (JSON.parse(plan.stdout) as { artifact_id: string }).artifact_id;
    const runId = `run-${randomUUID()}`;
    const store = new ArtifactStore({ repoRoot: repo.path, config: await loadConfig(repo.path) });
    await store.writeEvaluatorRunPayload(
      artifactId,
      {
        schema: 'orcaops.evaluator_run/v1',
        run_id: runId,
        artifact_id: artifactId,
        evaluator_ref: 'test/warning',
        package_id: 'test',
        evaluator_id: 'warning',
        phase: 'pre-pr',
        severity: 'warn',
        run_status: 'completed',
        verdict: 'violation',
        body: 'review this warning',
        ts: new Date().toISOString(),
      },
      { idempotencyKey: `warning-${randomUUID()}` }
    );
    const review = await store.writePrePrChecked(artifactId, {
      head_sha: await gitClient(repo.path).revparse(['HEAD']),
      outcome: 'needs_attention',
      evaluator_set_fingerprint: 'a'.repeat(64),
      review_context_fingerprint: 'b'.repeat(64),
      run_ids: [runId],
    });
    store.close();

    const acceptedWarnings = [
      {
        review_id: review.event_id,
        run_id: runId,
        evaluator_ref: 'test/warning',
        reason: 'reviewed and accepted',
      },
    ];
    const first = await agent.runRaw([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: artifactId,
          outcome: 'first wording',
          accepted_warnings: acceptedWarnings,
        })
      ),
    ]);
    expect(first.exitCode, first.stdout).toBe(0);
    const summaryEventId = (JSON.parse(first.stdout) as { summary_event_id: string })
      .summary_event_id;

    await writeFile(path.join(repo.path, 'uncommitted.ts'), 'export const changed = true;\n');

    const amended = await agent.runRaw([
      'finish',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `sum-${randomUUID()}`,
          artifact_id: artifactId,
          outcome: 'amended wording',
          prior_summary_event_id: summaryEventId,
          accepted_warnings: acceptedWarnings,
        })
      ),
    ]);
    expect(amended.exitCode, amended.stdout).toBe(0);
    expect(JSON.parse(amended.stdout)).toMatchObject({
      ok: true,
      finalization_status: 'finalized',
    });
    const shown = JSON.parse((await agent.runRaw(['show', artifactId, '--json'])).stdout) as {
      artifact: { summary: { outcome: string; accepted_warnings: unknown[] } };
    };
    expect(shown.artifact.summary.outcome).toBe('amended wording');
    expect(shown.artifact.summary.accepted_warnings).toEqual(acceptedWarnings);
  }, 30_000);

  // ── head_sha is not restamped by an amendment ────────────────────────
  //
  // This is the layer where derivation actually happens: the CLI reads current
  // HEAD. Amending after later commits must not move the window the summary
  // records, or an artifact reviewed at one commit silently claims a head it
  // never saw.
  it('an amendment taken after a later commit keeps the original head_sha', async () => {
    const { artifactId, summaryEventId } = await planAndSummary();

    const headAtSummary = (await agent.runRaw(['show', artifactId, '--json'])).stdout;
    const originalHead = (
      JSON.parse(headAtSummary) as { artifact: { summary: { head_sha: string } } }
    ).artifact.summary.head_sha;
    expect(originalHead).toBeTruthy();

    // Move HEAD after the summary was captured, and confirm it actually moved —
    // otherwise this test would pass vacuously.
    await commitFile(repo.path, 'later.ts', 'export const later = 1;\n', 'work after summary');
    const newHead = await gitClient(repo.path).revparse(['HEAD']);
    expect(newHead).not.toBe(originalHead);

    const amend = await reSummary(artifactId, {
      outcome: 'amended after a later commit',
      prior_summary_event_id: summaryEventId,
    });
    expect(amend.exitCode, amend.stdout).toBe(0);

    const after = JSON.parse((await agent.runRaw(['show', artifactId, '--json'])).stdout) as {
      artifact: { summary: { head_sha: string; outcome: string } };
    };
    expect(after.artifact.summary.outcome).toBe('amended after a later commit');
    expect(after.artifact.summary.head_sha).toBe(originalHead);
  }, 30_000);
});
