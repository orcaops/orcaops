import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runKnowledgeWorker } from '../../src/knowledge-worker/loop.js';
import { knowledgeWorkerFixture } from '../../src/knowledge-worker/worker-fixture.test-support.js';

// The grant belongs only to the disposable fixture; no real project consent is changed.
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: () => true,
}));

describe.skipIf(process.env.RUN_CODEX_KNOWLEDGE_TESTS !== '1')('live Codex processing', () => {
  it('interprets one consented temporary-project capture with the selected model', async () => {
    const authHome = process.env.LIVE_CODEX_AUTH_HOME;
    if (authHome === undefined || !path.isAbsolute(authHome)) {
      throw new Error('Set LIVE_CODEX_AUTH_HOME explicitly to an authenticated Codex home.');
    }
    const model = process.env.LIVE_CODEX_MODEL ?? 'gpt-5.6-terra';
    const fixture = await knowledgeWorkerFixture({
      providerId: 'codex',
      processing: {
        enabled: true,
        provider: 'codex',
        tool_access: 'codex_restricted',
        model,
        effort: 'medium',
        timeout_ms: 60_000,
        max_attempts: 1,
        max_calls_per_hour: 1,
        max_cost_usd_per_call: 'none',
      },
      llm: { tool: 'codex' },
    });
    try {
      const temporaryHome = path.join(fixture.scratchParentDir, 'home');
      await mkdir(temporaryHome);
      const { jobId } = await fixture.admit({
        task: 'The status page must be read-only and must not change stored project settings.',
      });
      const report = await runKnowledgeWorker({
        authority: fixture.authority,
        projectId: fixture.projectId,
        providerAvailability: { claude: 'absent', codex: 'present' },
        idleExitMs: 1,
        scratchParentDir: fixture.scratchParentDir,
        env: {
          ...fixture.env,
          HOME: temporaryHome,
          CODEX_HOME: authHome,
          ORCAOPS_CODEX_PATH: process.env.LIVE_CODEX_PATH ?? 'codex',
        },
        log: () => undefined,
      });
      const job = fixture.job(jobId);
      const attempts = fixture.attempts(jobId);
      const result = job.result as Record<string, unknown>;
      console.info(
        JSON.stringify({
          model,
          report,
          job: {
            state: job.state,
            coverage: result?.coverage,
            quality: result?.interpretation_quality,
            waitReason: job.waitReason,
          },
          attempts: attempts.map(({ outcome, usage, configuration }) => ({
            outcome,
            usage,
            configuration,
          })),
        })
      );
      expect(report.callsMade).toBe(1);
      expect(job.state).toBe('completed');
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ outcome: 'succeeded', usage: { cost_usd: null } });
      expect(result).toMatchObject({
        coverage: { scheduled_units: 1, settled_units: 1, unfinished_unit_ids: [] },
      });
      const plan = result.reconciliation_plan as { records: unknown[] };
      expect(plan.records.length).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  }, 90_000);
});
