import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readProcessingModelConfirmationHistory } from '@orcaops/storage/history/database';

import { knowledgeModelResumeAction } from './model-resume.js';
import { knowledgeRetryAction } from './retry.js';
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
 * `orcaops knowledge resume --model`, against a real project database holding
 * jobs a real capture settlement admitted, a real user-local grant store, and
 * the real worker. Only the person at the terminal is replaced.
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

async function fixture(): Promise<WorkerFixture> {
  const made = await knowledgeWorkerFixture({ provider: KNOWLEDGE_PROPOSER });
  fixtures.push(made);
  return made;
}

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

function resume(
  f: WorkerFixture,
  opts: Parameters<typeof knowledgeModelResumeAction>[0] = {}
): Promise<void> {
  return runInInvocationContext({ cwd: f.repoPath, env: f.env }, () =>
    knowledgeModelResumeAction({ terminal: terminal(), ...opts })
  );
}

function retry(f: WorkerFixture, job?: string): Promise<void> {
  return runInInvocationContext({ cwd: f.repoPath, env: f.env }, () =>
    knowledgeRetryAction({ ...(job === undefined ? {} : { job }), json: true })
  );
}

function work(
  f: WorkerFixture,
  log: (line: string) => void = () => {}
): Promise<KnowledgeWorkerReport> {
  return runKnowledgeWorker({
    authority: f.authority,
    projectId: f.projectId,
    providerAvailability: { claude: 'present', codex: 'absent' },
    log,
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

describe('orcaops knowledge resume --model', () => {
  it('holds a no-model capture until it is resumed, and the worker then claims it', async () => {
    const f = await fixture();
    const { jobId } = await f.captureAndAdmit(undefined, true);

    // Before the resume: a retry cannot make it due, and says what does.
    await retry(f, jobId);
    expect(lastJson(stdout)).toMatchObject({
      retried: [{ job_id: jobId, outcome: 'held' }],
      wake_up: null,
    });
    const held = await work(f);
    expect(held.callsMade).toBe(0);
    expect(f.job(jobId).state).toBe('pending');

    stdout.length = 0;
    await resume(f, { job: jobId, json: true });

    const shown = stderr.join('');
    expect(shown).toContain('the plan_captured of artifact');
    expect(shown).toContain('Provider: claude, run on this machine.');
    expect(asked).toHaveLength(1);
    const resumed = lastJson(stdout);
    expect(resumed).toMatchObject({
      resumed: [{ job_id: jobId, outcome: 'resumed' }],
    });
    const record = f.job(jobId).modelResume!;
    expect(record.grantId).toMatch(/^[0-9a-f-]{36}$/);
    // Nothing local authenticates who typed this, and the record says so.
    expect(record.resumedByBasis).not.toBe('authenticated');
    expect(record.resumedBy).toBeTruthy();
    // The choice is lifted, not erased.
    expect(f.job(jobId).withoutModel).toBe(true);
    expect(f.job(jobId)).toMatchObject({ waitReason: null, retryAt: null });

    const logs: string[] = [];
    const after = await work(f, (line) => logs.push(line));
    expect(
      after.callsMade,
      `${after.detail}; ${f.job(jobId).waitReason}; ${logs.join(' | ')}`
    ).toBe(1);
    expect(f.job(jobId).state).toBe('completed');
  }, 60_000);

  it('refuses when there is no interactive terminal, and records nothing', async () => {
    const f = await fixture();
    const { jobId } = await f.captureAndAdmit(undefined, true);

    await expect(
      runInInvocationContext({ cwd: f.repoPath, env: f.env }, () =>
        knowledgeModelResumeAction({
          job: jobId,
          terminal: terminal({ isInteractive: () => false }),
        })
      )
    ).rejects.toBeInstanceOf(CliExit);

    expect(stderr.join('')).toContain('only be given at an interactive terminal');
    // Nothing was shown either: a pipe is refused before the terms are drafted.
    expect(stderr.join('')).not.toContain('Provider: claude');
    expect(f.job(jobId).modelResume).toBeNull();
  }, 60_000);

  it('records nothing when consent does not cover the job', async () => {
    const f = await fixture();
    const { jobId } = await f.captureAndAdmit(undefined, true);
    await f.revoke();

    await expect(resume(f, { job: jobId })).rejects.toBeInstanceOf(CliExit);

    expect(stderr.join('')).toContain('CONSENT_DENIED');
    expect(stderr.join('')).toContain('revoked');
    expect(f.job(jobId).modelResume).toBeNull();
    const worker = await work(f);
    expect(worker.callsMade).toBe(0);
  }, 60_000);

  it('resumes with --all only the jobs admitted without a model and not yet resumed', async () => {
    const f = await fixture();
    const eligible = await f.captureAndAdmit('A model may see this capture.', false);
    const first = await f.captureAndAdmit('The first capture asked for no model.', true);
    const second = await f.captureAndAdmit('The second capture asked for no model.', true);
    await resume(f, { job: first.jobId });
    const alreadyResumed = f.job(first.jobId).modelResume!;
    stdout.length = 0;

    await resume(f, { all: true, json: true });

    expect(lastJson(stdout)).toMatchObject({
      resumed: [{ job_id: second.jobId, outcome: 'resumed' }],
    });
    expect(f.job(second.jobId).modelResume).not.toBeNull();
    // The one already resumed keeps its original record, and the one that never
    // needed a resume has none.
    expect(f.job(first.jobId).modelResume).toEqual(alreadyResumed);
    expect(f.job(eligible.jobId).modelResume).toBeNull();
  }, 60_000);

  it('uses the originating worktree even when the invoking checkout is disabled', async () => {
    const f = await fixture();
    const origin = await f.addWorktree('origin', { enabled: true, max_calls_per_hour: 60 });
    await f.writeConfig({ enabled: false, max_calls_per_hour: 60 });
    const { jobId } = await f.admit({ worktreeRoot: origin, withoutModel: true });

    await resume(f, { job: jobId });

    expect(stderr.join('')).toContain(`originating worktree ${origin}`);
    expect(f.job(jobId).modelResume).not.toBeNull();
  }, 60_000);

  it('requires a fresh prompt when terms become looser after the answer', async () => {
    const f = await fixture();
    const { jobId } = await f.admit({ withoutModel: true });
    const changingTerminal = terminal({
      ask: async (question: string) => {
        asked.push(question);
        await f.writeConfig({ enabled: true, max_calls_per_hour: 60, max_output_bytes: 100_000 });
        return 'yes';
      },
    });

    await expect(resume(f, { job: jobId, terminal: changingTerminal })).rejects.toBeInstanceOf(
      CliExit
    );

    expect(stderr.join('')).toContain('Confirm the new terms again');
    expect(
      f.handle.read((view) => readProcessingModelConfirmationHistory(view, jobId)).value
    ).toEqual([]);
  }, 60_000);

  it('retains the displayed envelope when current limits become tighter', async () => {
    const f = await fixture();
    const { jobId } = await f.admit({ withoutModel: true });
    const changingTerminal = terminal({
      ask: async (question: string) => {
        asked.push(question);
        await f.writeConfig({ enabled: true, max_calls_per_hour: 60, max_output_bytes: 1024 });
        return 'yes';
      },
    });

    await resume(f, { job: jobId, terminal: changingTerminal });

    const [confirmation] = f.handle.read((view) =>
      readProcessingModelConfirmationHistory(view, jobId)
    ).value;
    expect(confirmation.terms.limits.max_output_bytes).toBe(65_536);
  }, 60_000);

  it('appends a named reconfirmation without replacing the first', async () => {
    const f = await fixture();
    const { jobId } = await f.admit({ withoutModel: true });
    await resume(f, { job: jobId });
    await resume(f, { job: jobId });

    const history = f.handle.read((view) =>
      readProcessingModelConfirmationHistory(view, jobId)
    ).value;
    expect(history.map((entry) => entry.confirmationSequence)).toEqual([1, 2]);
    expect(history[0]!.confirmationId).not.toBe(history[1]!.confirmationId);
  }, 60_000);

  it('requires reconfirmation when terms become looser after confirmation', async () => {
    const f = await fixture();
    const { jobId } = await f.admit({ withoutModel: true });
    await resume(f, { job: jobId });
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

    const report = await work(f);

    expect(report.callsMade).toBe(0);
    expect(f.job(jobId)).toMatchObject({
      state: 'pending',
      waitReason: 'model_reconfirmation_required',
    });
  }, 60_000);

  it('refuses a job whose originating worktree context is missing', async () => {
    const f = await fixture();
    const { jobId } = await f.admit({ withoutModel: true, withoutDispatchContext: true });

    await expect(resume(f, { job: jobId })).rejects.toBeInstanceOf(CliExit);

    expect(stderr.join('')).toContain('no usable originating worktree');
    expect(
      f.handle.read((view) => readProcessingModelConfirmationHistory(view, jobId)).value
    ).toEqual([]);
  }, 60_000);

  it('refuses a batch whose originating worktrees resolve different envelopes', async () => {
    const f = await fixture();
    const restricted = await f.addWorktree('restricted-resume', {
      enabled: true,
      max_calls_per_hour: 1,
    });
    await f.admit({ withoutModel: true });
    await f.admit({ withoutModel: true, worktreeRoot: restricted });

    await expect(resume(f, { all: true })).rejects.toBeInstanceOf(CliExit);

    expect(stderr.join('')).toContain('different providers, models, effort, tools or limits');
    expect(asked).toEqual([]);
  }, 60_000);

  it('refuses --model with neither a job nor --all, and says which to pass', async () => {
    const f = await fixture();
    await f.captureAndAdmit(undefined, true);

    await expect(resume(f, {})).rejects.toBeInstanceOf(CliExit);

    expect(stderr.join('')).toContain('resume --model <job>');
    expect(stderr.join('')).toContain('--model --all');
  }, 60_000);
});
