import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readProcessingJobReopenings,
  readProcessingModelConfirmationHistory,
} from '@orcaops/storage/history/database';

import { knowledgeModelResumeAction } from './model-resume.js';
import { knowledgeReopenAction } from './reopen.js';
import { CliExit } from '../../io/exit.js';
import { type KnowledgeWorkerReport, runKnowledgeWorker } from '../../knowledge-worker/loop.js';
import {
  KNOWLEDGE_PROPOSER,
  knowledgeWorkerFixture,
  type WorkerFixture,
} from '../../knowledge-worker/worker-fixture.test-support.js';
import { runInInvocationContext } from '../../lib/invocation-context.js';
import { consentTerminal } from '../../lib/knowledge-processing-terminal.js';

/**
 * `orcaops knowledge reopen`, against a real project database holding a job the
 * real worker gave up on, a real user-local grant store, and the real worker.
 * Only the person at the terminal is replaced.
 */

// The fixture records its grant through the store API, which only a terminal
// may do. What the verb under test demands of a terminal is its own check,
// answered by the terminal it is handed.
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: () => true,
}));

const fixtures: WorkerFixture[] = [];
let stdout: string[];
let stderr: string[];
const answers: string[] = [];
const asked: string[] = [];

beforeEach(() => {
  stdout = [];
  stderr = [];
  answers.length = 0;
  asked.length = 0;
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

function terminal(overrides: Partial<typeof consentTerminal> = {}) {
  return {
    isInteractive: () => true,
    ask: (question: string) => {
      asked.push(question);
      return Promise.resolve(answers.shift() ?? 'yes');
    },
    confirm: consentTerminal.confirm,
    ...overrides,
  };
}

function reopen(
  f: WorkerFixture,
  opts: Parameters<typeof knowledgeReopenAction>[0] = {}
): Promise<void> {
  return runInInvocationContext({ cwd: f.repoPath, env: f.env }, () =>
    knowledgeReopenAction({ terminal: terminal(), json: true, ...opts })
  );
}

function work(f: WorkerFixture): Promise<KnowledgeWorkerReport> {
  return runKnowledgeWorker({
    authority: f.authority,
    projectId: f.projectId,
    providerAvailability: { claude: 'present', codex: 'absent' },
    log: () => {},
    idleExitMs: 1,
    env: f.env,
    heartbeatMs: 250,
    leaseTermMs: 2_000,
    killGraceMs: 200,
    scratchParentDir: f.scratchParentDir,
  });
}

const lastJson = (lines: string[]): Record<string, unknown> =>
  JSON.parse(lines.join('').trim().split('\n').at(-1)!) as Record<string, unknown>;

const reopenings = (f: WorkerFixture, jobId: string) =>
  f.handle.read((view) => readProcessingJobReopenings(view, jobId)).value;

/** A job the worker gave up on: the proposer answers about a manifest it was never asked for. */
async function gaveUp(options: { withoutModel?: boolean } = {}) {
  const f = await knowledgeWorkerFixture({
    provider: KNOWLEDGE_PROPOSER,
    proposerAnswer: 'wrong-manifest',
  });
  fixtures.push(f);
  const { jobId } = await f.admit({ withoutModel: options.withoutModel ?? false });
  if (options.withoutModel === true)
    await runInInvocationContext({ cwd: f.repoPath, env: f.env }, () =>
      knowledgeModelResumeAction({ job: jobId, terminal: terminal() })
    );
  await work(f);
  expect(f.job(jobId).state).toBe('terminal_failure');
  f.env.FAKE_PROPOSER_ANSWER = 'statement';
  stdout.length = 0;
  stderr.length = 0;
  asked.length = 0;
  return { f, jobId };
}

describe('orcaops knowledge reopen', () => {
  it('shows why the job gave up and the terms, then reopens it with the allowance shown', async () => {
    const { f, jobId } = await gaveUp();

    await reopen(f, { job: jobId });

    const shown = stderr.join('');
    expect(shown).toContain(`Job ${jobId} gave up at`);
    expect(shown).toContain('the proposal was refused (MANIFEST_MISMATCH)');
    expect(shown).toContain('1 attempt(s) made so far.');
    expect(shown).toContain(
      'Reopening allows up to 3 more attempt(s), and every attempt is a paid call.'
    );
    expect(shown).toContain(
      'A later configuration change can lower this allowance but not raise it.'
    );
    expect(shown).toContain('Provider: claude, run on this machine.');
    expect(asked).toEqual(['Type "yes" to reopen this job, anything else declines: ']);
    expect(lastJson(stdout)).toMatchObject({
      ok: true,
      reopened: {
        job_id: jobId,
        reopening_sequence: 1,
        attempts_allowed: 3,
        grant_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        model_resume_required: false,
      },
    });
    const [reopening] = reopenings(f, jobId);
    expect(reopening).toMatchObject({
      attemptsBefore: 1,
      attemptsAllowed: 3,
      gaveUp: { failures: [{ rule: 'MANIFEST_MISMATCH' }] },
    });
    // Nothing local authenticates who typed this, and the record says so.
    expect(reopening!.reopenedByBasis).not.toBe('authenticated');
    expect(f.job(jobId)).toMatchObject({ state: 'pending', result: null });

    const after = await work(f);
    expect(after.callsMade, after.detail).toBe(1);
    expect(f.job(jobId).state).toBe('completed');
  }, 60_000);

  it('refuses without an interactive terminal, before showing or recording anything', async () => {
    const { f, jobId } = await gaveUp();

    await expect(
      reopen(f, { job: jobId, terminal: terminal({ isInteractive: () => false }) })
    ).rejects.toBeInstanceOf(CliExit);

    expect(lastJson(stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('only be reopened at an interactive terminal') },
    });
    expect(stderr.join('')).not.toContain('Provider: claude');
    expect(asked).toEqual([]);
    expect(reopenings(f, jobId)).toEqual([]);
    expect(f.job(jobId).state).toBe('terminal_failure');
  }, 60_000);

  it('records nothing when the answer is anything but yes', async () => {
    const { f, jobId } = await gaveUp();
    answers.push('y');

    await expect(reopen(f, { job: jobId })).rejects.toBeInstanceOf(CliExit);

    expect(lastJson(stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Declined') },
    });
    expect(reopenings(f, jobId)).toEqual([]);
    expect(f.job(jobId).state).toBe('terminal_failure');
  }, 60_000);

  it('refuses a job that has not given up, and names what frees it', async () => {
    const f = await knowledgeWorkerFixture({ provider: KNOWLEDGE_PROPOSER });
    fixtures.push(f);
    const { jobId } = await f.admit();

    await expect(reopen(f, { job: jobId })).rejects.toBeInstanceOf(CliExit);
    expect(lastJson(stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining(`\`orcaops knowledge retry ${jobId}\``) },
    });

    await work(f);
    expect(f.job(jobId).state).toBe('completed');
    stdout.length = 0;
    await expect(reopen(f, { job: jobId })).rejects.toBeInstanceOf(CliExit);
    expect(lastJson(stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('a completed job is never run again') },
    });
    expect(asked).toEqual([]);
    expect(reopenings(f, jobId)).toEqual([]);
  }, 60_000);

  it('refuses and records nothing when consent does not cover the job', async () => {
    const { f, jobId } = await gaveUp();
    await f.revoke();

    await expect(reopen(f, { job: jobId })).rejects.toBeInstanceOf(CliExit);

    expect(lastJson(stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('CONSENT_DENIED') },
    });
    expect(asked).toEqual([]);
    expect(reopenings(f, jobId)).toEqual([]);
  }, 60_000);

  it('records nothing when consent is withdrawn while the question is open', async () => {
    const { f, jobId } = await gaveUp();
    const withdrawing = terminal({
      ask: async (question: string) => {
        asked.push(question);
        await f.revoke();
        return 'yes';
      },
    });

    await expect(reopen(f, { job: jobId, terminal: withdrawing })).rejects.toBeInstanceOf(CliExit);

    expect(lastJson(stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('CONSENT_DENIED') },
    });
    expect(reopenings(f, jobId)).toEqual([]);
    expect(f.job(jobId).state).toBe('terminal_failure');
  }, 60_000);

  it('records nothing when the terms widen while the question is open', async () => {
    const { f, jobId } = await gaveUp();
    const widening = terminal({
      ask: async (question: string) => {
        asked.push(question);
        await f.writeConfig({ enabled: true, max_calls_per_hour: 60, max_attempts: 5 });
        return 'yes';
      },
    });

    await expect(reopen(f, { job: jobId, terminal: widening })).rejects.toBeInstanceOf(CliExit);

    expect(lastJson(stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('changed outside what was shown (max_attempts)') },
    });
    expect(reopenings(f, jobId)).toEqual([]);
  }, 60_000);

  it('records the allowance that was shown when configuration tightens while the question is open', async () => {
    const { f, jobId } = await gaveUp();
    const tightening = terminal({
      ask: async (question: string) => {
        asked.push(question);
        await f.writeConfig({ enabled: true, max_calls_per_hour: 60, max_attempts: 1 });
        return 'yes';
      },
    });

    await reopen(f, { job: jobId, terminal: tightening });

    expect(reopenings(f, jobId)).toMatchObject([{ attemptsAllowed: 3 }]);
  }, 60_000);

  it('leaves the model to resume --model for a no-model job whose terms changed', async () => {
    const { f, jobId } = await gaveUp({ withoutModel: true });
    const confirmations = () =>
      f.handle.read((view) => readProcessingModelConfirmationHistory(view, jobId)).value;
    expect(confirmations()).toHaveLength(1);
    await f.writeConfig({ enabled: true, max_calls_per_hour: 60, max_output_bytes: 100_000 });
    await f.grant({
      disclosed: {
        tool_access: 'none',
        model: { selection: 'provider_default' },
        limits: {
          max_cost_usd_per_call: 'none',
          max_cost_usd_per_day: 'none',
          max_calls_per_hour: 60,
          max_input_bytes: 131_072,
          max_output_bytes: 100_000,
        },
        paused_backlog_count: 0,
      },
    });

    await reopen(f, { job: jobId });

    expect(stderr.join('')).toContain(
      `the job waits until you run \`orcaops knowledge resume --model ${jobId}\` at a terminal`
    );
    expect(lastJson(stdout)).toMatchObject({
      reopened: { job_id: jobId, model_resume_required: true },
    });
    expect(confirmations()).toHaveLength(1);

    const held = await work(f);
    expect(held.callsMade).toBe(0);
    expect(f.job(jobId)).toMatchObject({
      state: 'pending',
      waitReason: 'model_reconfirmation_required',
    });

    await runInInvocationContext({ cwd: f.repoPath, env: f.env }, () =>
      knowledgeModelResumeAction({ job: jobId, terminal: terminal() })
    );
    expect(confirmations()).toHaveLength(2);
    const after = await work(f);
    expect(after.callsMade, after.detail).toBe(1);
    expect(f.job(jobId).state).toBe('completed');
  }, 90_000);
});
