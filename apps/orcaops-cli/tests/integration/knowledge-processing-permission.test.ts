import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONFIG_SCHEMA_VERSION } from '@orcaops/storage';
import {
  readInterpretationProgress,
  readProcessingModelConfirmationHistory,
} from '@orcaops/storage/history/database';

import { knowledgeModelResumeAction } from '../../src/commands/knowledge/model-resume.js';
import { CliExit } from '../../src/io/exit.js';
import { type KnowledgeWorkerReport, runKnowledgeWorker } from '../../src/knowledge-worker/loop.js';
import {
  FAKE_CLAUDE,
  KNOWLEDGE_PROPOSER,
  knowledgeWorkerFixture,
  type WorkerFixture,
  type WorkerFixtureOptions,
} from '../../src/knowledge-worker/worker-fixture.test-support.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import {
  readProcessingGrants,
  revokeProcessingGrants,
} from '../../src/lib/knowledge-processing-grants.js';
import { consentTerminal } from '../../src/lib/knowledge-processing-terminal.js';

vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: () => true,
}));

const DEFAULT_PROCESSING = {
  enabled: true,
  provider: 'claude',
  max_attempts: 3,
  max_calls_per_hour: 60,
  max_input_bytes: 131_072,
  max_output_bytes: 65_536,
};

const fixtures: WorkerFixture[] = [];
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function writeProcessingConfig(root: string, processing: Record<string, unknown>) {
  await writeFile(
    path.join(root, '.orcaops', 'config.json'),
    `${JSON.stringify(
      {
        schema_version: CONFIG_SCHEMA_VERSION,
        install: { scope: 'project' },
        knowledge_processing: processing,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function crossWorktreeFixture(options: WorkerFixtureOptions = {}) {
  const fixture = await knowledgeWorkerFixture({ provider: KNOWLEDGE_PROPOSER, ...options });
  fixtures.push(fixture);
  await fixture.writeConfig({
    enabled: false,
    provider: 'codex',
    tool_access: 'codex_restricted',
    max_calls_per_hour: 1,
  });
  const origin = await fixture.addWorktree('processing-origin', DEFAULT_PROCESSING);
  const { jobId } = await fixture.admit({ worktreeRoot: origin, withoutModel: true });
  return { fixture, origin, jobId };
}

function terminal(ask: (question: string) => Promise<string> = async () => 'yes') {
  return { isInteractive: () => true, ask, confirm: consentTerminal.confirm };
}

function resume(fixture: WorkerFixture, jobId: string, prompt = terminal()): Promise<void> {
  return runInInvocationContext({ cwd: fixture.repoPath, env: fixture.env }, () =>
    knowledgeModelResumeAction({ job: jobId, json: true, terminal: prompt })
  );
}

function work(
  fixture: WorkerFixture,
  overrides: Partial<Parameters<typeof runKnowledgeWorker>[0]> = {}
): Promise<KnowledgeWorkerReport> {
  const stop = new AbortController();
  return runKnowledgeWorker({
    authority: fixture.authority,
    projectId: fixture.projectId,
    providerAvailability: { claude: 'present', codex: 'present' },
    log() {},
    idleExitMs: 1,
    signal: stop.signal,
    sleep: async () => stop.abort(),
    env: fixture.env,
    heartbeatMs: 250,
    leaseTermMs: 2_000,
    revalidateMs: 100,
    killGraceMs: 200,
    scratchParentDir: fixture.scratchParentDir,
    ...overrides,
  });
}

async function addCodexGrant(fixture: WorkerFixture): Promise<void> {
  await fixture.grant({
    provider: 'codex',
    disclosed: {
      tool_access: 'codex_restricted',
      model: { selection: 'provider_default' },
      limits: {
        max_cost_usd_per_call: 'none',
        max_cost_usd_per_day: 'none',
        max_calls_per_hour: 60,
        max_input_bytes: 131_072,
        max_output_bytes: 65_536,
      },
      paused_backlog_count: 0,
    },
  });
}

async function revokeClaude(fixture: WorkerFixture, origin: string): Promise<void> {
  await revokeProcessingGrants(
    { project_id: fixture.projectId, provider: 'claude' },
    { repoRoot: origin, configDir: fixture.configHome }
  );
}

function revokeClaudeWhileBlocked(fixture: WorkerFixture): void {
  const grantFile = path.join(fixture.configHome, 'knowledge-processing-grants.json');
  const store = JSON.parse(readFileSync(grantFile, 'utf8')) as {
    grants: { provider: string; revoked_at?: string }[];
  };
  const revokedAt = new Date().toISOString();
  store.grants = store.grants.map((grant) =>
    grant.provider === 'claude' && grant.revoked_at === undefined
      ? { ...grant, revoked_at: revokedAt }
      : grant
  );
  writeFileSync(grantFile, `${JSON.stringify(store, null, 2)}\n`);
}

function expectOnlyCodexRemains(fixture: WorkerFixture, origin: string): void {
  const { grants, problems } = readProcessingGrants({
    repoRoot: origin,
    configDir: fixture.configHome,
  });
  expect(problems).toEqual([]);
  expect(
    grants.filter((grant) => grant.revoked_at === undefined).map((grant) => grant.provider)
  ).toEqual(['codex']);
}

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition never held');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('a resumed job keeps the permission its originating worktree disclosed', () => {
  it('records nothing when the origin becomes looser while the confirmation is open', async () => {
    const { fixture, origin, jobId } = await crossWorktreeFixture();

    await expect(
      resume(
        fixture,
        jobId,
        terminal(async () => {
          await writeProcessingConfig(origin, {
            ...DEFAULT_PROCESSING,
            max_output_bytes: 100_000,
          });
          return 'yes';
        })
      )
    ).rejects.toBeInstanceOf(CliExit);

    expect(stderr.join('')).toContain(`originating worktree ${origin}`);
    expect(stderr.join('')).toContain('Provider: claude');
    expect(stderr.join('')).toContain('65536 response bytes kept per call');
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: expect.stringContaining('Confirm the new terms again'),
      },
    });
    expect(
      fixture.handle.read((view) => readProcessingModelConfirmationHistory(view, jobId)).value
    ).toEqual([]);
  }, 30_000);

  it('retains the displayed envelope and dispatches under a later tighter origin limit', async () => {
    const { fixture, origin, jobId } = await crossWorktreeFixture();

    await resume(
      fixture,
      jobId,
      terminal(async () => {
        await writeProcessingConfig(origin, {
          ...DEFAULT_PROCESSING,
          max_output_bytes: 32_768,
        });
        return 'yes';
      })
    );

    expect(stderr.join('')).toContain(`originating worktree ${origin}`);
    expect(stderr.join('')).toContain('Provider: claude');
    expect(stderr.join('')).not.toContain('Provider: codex');
    const [confirmation] = fixture.handle.read((view) =>
      readProcessingModelConfirmationHistory(view, jobId)
    ).value;
    expect(confirmation.terms).toMatchObject({
      origin: { worktree_root: origin },
      provider: { id: 'claude' },
      limits: { max_output_bytes: 65_536 },
    });

    const report = await work(fixture);

    expect(report.callsMade).toBe(1);
    expect(fixture.job(jobId).state).toBe('completed');
    const [attempt] = fixture.attempts(jobId);
    expect(attempt.configuration).toMatchObject({
      limits: { max_output_bytes: 32_768 },
      permission: {
        confirmation_id: confirmation.confirmationId,
        confirmed_terms: { limits: { max_output_bytes: 65_536 } },
        execution_terms: {
          origin: { worktree_root: origin },
          provider: { id: 'claude' },
          limits: { max_output_bytes: 32_768 },
        },
      },
    });
    expect(fixture.knowledgeRows()).toBeGreaterThan(0);
  }, 30_000);

  it('requires another confirmation when the origin changes provider before dispatch', async () => {
    const { fixture, origin, jobId } = await crossWorktreeFixture();
    await resume(fixture, jobId);
    const [confirmation] = fixture.handle.read((view) =>
      readProcessingModelConfirmationHistory(view, jobId)
    ).value;
    await addCodexGrant(fixture);
    await writeProcessingConfig(origin, {
      ...DEFAULT_PROCESSING,
      provider: 'codex',
      tool_access: 'codex_restricted',
    });

    const report = await work(fixture);

    expect(report.callsMade).toBe(0);
    expect(existsSync(fixture.providerStartedMarker)).toBe(false);
    expect(fixture.job(jobId)).toMatchObject({
      state: 'pending',
      waitReason: 'model_reconfirmation_required',
    });
    expect(
      fixture.handle
        .read((view) => readProcessingModelConfirmationHistory(view, jobId))
        .value.map((entry) => entry.confirmationId)
    ).toEqual([confirmation.confirmationId]);
  }, 30_000);

  it('cancels the confirmed call when its grant is revoked despite another provider grant', async () => {
    const { fixture, origin, jobId } = await crossWorktreeFixture({
      provider: FAKE_CLAUDE,
      behavior: 'sleep',
    });
    await resume(fixture, jobId);
    const [confirmation] = fixture.handle.read((view) =>
      readProcessingModelConfirmationHistory(view, jobId)
    ).value;
    await addCodexGrant(fixture);

    const running = work(fixture);
    await waitFor(() => existsSync(fixture.providerStartedMarker));
    await revokeClaude(fixture, origin);
    const report = await running;

    expect(report.callsMade).toBe(1);
    expectOnlyCodexRemains(fixture, origin);
    expect(fixture.job(jobId)).toMatchObject({
      state: 'retryable_failure',
      waitReason: 'revoked',
      result: null,
    });
    const [attempt] = fixture.attempts(jobId);
    expect(attempt.configuration).toMatchObject({
      permission: { confirmation_id: confirmation.confirmationId },
    });
    expect(attempt.detail).toMatchObject({
      call: { code: 'CANCELLED' },
      withdrawn: { wait_reason: 'revoked' },
    });
    expect(fixture.knowledgeRows()).toBe(0);
  }, 30_000);

  it.each([
    ['an authored result', 'statement'],
    ['a no-new-row result', 'empty'],
  ] as const)(
    'publishes nothing when %s waits for a writer after the confirmed grant is revoked',
    async (_description, proposerAnswer) => {
      const { fixture, origin, jobId } = await crossWorktreeFixture({ proposerAnswer });
      await resume(fixture, jobId);
      const [confirmation] = fixture.handle.read((view) =>
        readProcessingModelConfirmationHistory(view, jobId)
      ).value;
      await addCodexGrant(fixture);
      const blocker = new Database(fixture.handle.databasePath);
      let waits = 0;
      try {
        const running = work(fixture, {
          beforePublication: () => {
            blocker.exec('BEGIN IMMEDIATE');
          },
          onPublicationWait: () => {
            waits += 1;
            revokeClaudeWhileBlocked(fixture);
            blocker.exec('COMMIT');
          },
        });

        const report = await running;

        expect(report.callsMade).toBe(1);
        expect(waits).toBe(1);
        expectOnlyCodexRemains(fixture, origin);
        expect(fixture.job(jobId)).toMatchObject({
          state: 'retryable_failure',
          waitReason: 'revoked',
          result: null,
        });
        const [attempt] = fixture.attempts(jobId);
        expect(attempt.configuration).toMatchObject({
          permission: { confirmation_id: confirmation.confirmationId },
        });
        expect(attempt.detail).toMatchObject({
          unit_settled: false,
          withdrawn: { wait_reason: 'revoked' },
        });
        expect(readInterpretationProgress(fixture.handle, jobId)?.receipts).toEqual([]);
        expect(fixture.knowledgeRows()).toBe(0);
      } finally {
        if (blocker.inTransaction) blocker.exec('ROLLBACK');
        blocker.close();
      }
    },
    30_000
  );
});
