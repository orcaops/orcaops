import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isatty } from 'node:tty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROCESSING_PROCESSOR_CONTRACT, smallestProcessableInputBytes } from '@orcaops/core';
import { measurePreparedInputRequest, type ProviderProbeSnapshot } from '@orcaops/llm';
import { getDefaultConfig, resolveConfig } from '@orcaops/storage';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { checkKnowledgeProcessing } from './doctor.js';
import { WORKER_PAUSE_ACTOR } from '../../knowledge-worker/wait-reasons.js';
import { runInInvocationContext } from '../../lib/invocation-context.js';
import {
  InteractiveConsentConfirmation,
  type ProcessingGrantTerms,
  recordProcessingGrant,
} from '../../lib/knowledge-processing-grants.js';
import type { ProcessingHistory } from '../../lib/knowledge-processing-queue.js';

// Recording a grant demands this process's own standard input and output be a
// terminal; a test runner's are not.
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: vi.fn(),
}));

const PROJECT_ID = '019606f0-0000-7000-8000-00000000000b';
const PRESENT: ProviderProbeSnapshot = { claude: 'present', codex: 'absent' };

let repo: TempRepo;
let configHome: string;
let previousConfigHome: string | undefined;

const terms: ProcessingGrantTerms = {
  project_id: PROJECT_ID,
  provider: 'claude',
  processor_contract: PROCESSING_PROCESSOR_CONTRACT,
  source_scope: { admitted_after_sequence: 0, backlog: 'included' },
  disclosed: {
    tool_access: 'none',
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
};

beforeEach(async () => {
  repo = await createTempRepo();
  configHome = await mkdtemp(path.join(tmpdir(), 'processing-doctor-'));
  previousConfigHome = process.env.ORCAOPS_CONFIG_HOME;
  process.env.ORCAOPS_CONFIG_HOME = configHome;
  execFileSync('git', ['config', '--local', 'orcaops.projectid', PROJECT_ID], { cwd: repo.path });
  await writeConfig();
});

afterEach(async () => {
  vi.mocked(isatty).mockReset();
  if (previousConfigHome === undefined) delete process.env.ORCAOPS_CONFIG_HOME;
  else process.env.ORCAOPS_CONFIG_HOME = previousConfigHome;
  await repo.cleanup();
  await rm(configHome, { recursive: true, force: true });
});

async function writeConfig(knowledgeProcessing?: Record<string, unknown>): Promise<void> {
  const file = path.join(repo.path, '.orcaops', 'config.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      knowledgeProcessing === undefined
        ? { schema_version: 6, install: { scope: 'project' } }
        : {
            schema_version: 8,
            install: { scope: 'project' },
            knowledge_processing: knowledgeProcessing,
          }
    ),
    'utf8'
  );
}

async function grant(): Promise<void> {
  vi.mocked(isatty).mockReturnValue(true);
  await recordProcessingGrant(terms, {
    repoRoot: repo.path,
    interactiveConfirmation: InteractiveConsentConfirmation.forTermsAcceptedAtTerminal(terms),
    configDir: configHome,
  });
}

function history(overrides: Partial<ProcessingHistory> = {}): ProcessingHistory {
  return {
    problem: null,
    backlog: { paused_jobs: 0, latest_admitted_sequence: null },
    queue: {
      jobs: { pending: 0, running: 0, completed: 0, retryable_failure: 0, terminal_failure: 0 },
      waiting: [],
      awaitingModelResume: 0,
      openAttempts: 0,
      latestAdmittedSequence: null,
      eligibleSources: 0,
      missingEligibleSources: 0,
      latestEligibleSequence: null,
    },
    control: null,
    lease: null,
    usage: null,
    gaveUp: null,
    target: null,
    boundary: 0,
    ...overrides,
  };
}

async function check(
  overrides: Partial<ProcessingHistory> = {},
  knowledgeProcessing?: Record<string, unknown>
) {
  if (knowledgeProcessing !== undefined) await writeConfig(knowledgeProcessing);
  const config = knowledgeProcessing
    ? resolveConfig({
        schema_version: 8,
        install: { scope: 'project' },
        knowledge_processing: knowledgeProcessing,
      })
    : getDefaultConfig();
  return runInInvocationContext({ cwd: repo.path, env: { ...process.env } }, () =>
    checkKnowledgeProcessing({
      repoRoot: repo.path,
      config,
      providerAvailability: PRESENT,
      history: history(overrides),
    })
  );
}

describe("doctor's background processing check", () => {
  it('reports the setting off, without calling it a fault', async () => {
    const reported = await check();
    expect(reported).toMatchObject({ name: 'knowledge-processing', status: 'pass' });
    expect(reported.summary).toContain('off');
    expect(reported.details?.join('\n')).toContain('orcaops knowledge enable');
  });

  it('reports a provider that cannot run this workload as unavailable', async () => {
    const reported = await check({}, { enabled: true, provider: 'codex' });
    expect(reported.status).toBe('warn');
    expect(reported.summary).toContain('unavailable');
    expect(reported.details?.join('\n')).toContain('tool');
  });

  it('reports an input cap below the floor, and names the cap that would work', async () => {
    const reported = await check({}, { enabled: true, max_input_bytes: 20_000 });

    expect(reported.status).toBe('warn');
    expect(reported.summary).toContain('unavailable');
    const details = reported.details?.join('\n') ?? '';
    expect(details).toContain('knowledge_processing.max_input_bytes');
    expect(details).toContain(
      String(
        smallestProcessableInputBytes({
          provider: 'claude',
          measure: { measurePreparedInputRequest },
        })
      )
    );
  });

  it('reports the consent decision by its own reason when no grant covers it', async () => {
    const reported = await check({}, { enabled: true });
    expect(reported.status).toBe('warn');
    expect(reported.summary).toContain('not consented [no_grant]');
    expect(reported.details?.join('\n')).toContain('No user-local grant authorizes');
  });

  it('reports who paused the project, and how to lift it', async () => {
    await grant();
    const reported = await check(
      {
        control: {
          paused: true,
          changedAt: '2026-09-01T00:00:00.000Z',
          changedBy: 'levi',
          changedByBasis: 'other_assertion',
          reason: 'the model is down',
        },
      },
      { enabled: true }
    );
    expect(reported.status).toBe('warn');
    expect(reported.summary).toContain('paused');
    expect(reported.summary).toContain('by a person');
    expect(reported.details?.join('\n')).toContain('levi (other_assertion)');
    expect(reported.details?.join('\n')).toContain('orcaops knowledge resume');
  });

  it('says the worker paused it, and quotes its reason, when the worker did', async () => {
    await grant();
    const reported = await check(
      {
        control: {
          paused: true,
          changedAt: '2026-09-01T00:00:00.000Z',
          changedBy: WORKER_PAUSE_ACTOR,
          changedByBasis: 'other_assertion',
          reason: 'TOOL_USE_OBSERVED: the no-tool mode did not hold.',
        },
      },
      { enabled: true }
    );

    expect(reported.status).toBe('warn');
    // Not "by a person": nobody would find the person who did this.
    expect(reported.summary).toContain('by the background worker');
    expect(reported.summary).not.toContain('by a person');
    expect(reported.details?.join('\n')).toContain('the no-tool mode did not hold');
    expect(reported.details?.join('\n')).toContain('orcaops knowledge resume');
  });

  it('reports being caught up when nothing is waiting', async () => {
    await grant();
    const reported = await check({}, { enabled: true });
    expect(reported).toMatchObject({ status: 'pass' });
    expect(reported.summary).toContain('caught up');
    expect(reported.details?.join('\n')).toContain("the provider's default model");
    expect(reported.details?.join('\n')).toContain('Limit: 60 calls per hour');
    expect(reported.details?.join('\n')).toContain('Tool access: none');
  });

  it('reports what is pending', async () => {
    await grant();
    const reported = await check(
      {
        backlog: { paused_jobs: 2, latest_admitted_sequence: 9 },
        queue: {
          jobs: { pending: 2, running: 0, completed: 1, retryable_failure: 0, terminal_failure: 0 },
          waiting: [],
          awaitingModelResume: 1,
          openAttempts: 0,
          latestAdmittedSequence: 9,
          eligibleSources: 3,
          missingEligibleSources: 0,
          latestEligibleSequence: 9,
        },
      },
      { enabled: true }
    );
    expect(reported).toMatchObject({ status: 'pass' });
    expect(reported.summary).toContain('2 job(s) pending');
    // The command that lifts it, by name: a reader is told what to run.
    expect(reported.details?.join('\n')).toContain('orcaops knowledge resume --model <job>');
  });

  it('reports a job that gave up and a job waiting on nothing as failing', async () => {
    await grant();
    const reported = await check(
      {
        queue: {
          jobs: { pending: 0, running: 0, completed: 0, retryable_failure: 1, terminal_failure: 1 },
          waiting: [{ waitReason: 'consent_denied', jobs: 1, nextRetryAt: null }],
          awaitingModelResume: 0,
          openAttempts: 0,
          latestAdmittedSequence: 4,
          eligibleSources: 2,
          missingEligibleSources: 0,
          latestEligibleSequence: 4,
        },
      },
      { enabled: true }
    );
    expect(reported.status).toBe('warn');
    expect(reported.summary).toContain('failing');
    expect(reported.details?.join('\n')).toContain('consent_denied');
    expect(reported.details?.join('\n')).toContain('orcaops knowledge retry');
    expect(reported.details?.join('\n')).toContain('orcaops knowledge reopen <job>');
  });

  it('points a job that gave up at reopen, not at retry', async () => {
    await grant();
    const reported = await check(
      {
        queue: {
          jobs: { pending: 0, running: 0, completed: 0, retryable_failure: 0, terminal_failure: 1 },
          waiting: [],
          awaitingModelResume: 0,
          openAttempts: 0,
          latestAdmittedSequence: 4,
          eligibleSources: 1,
          missingEligibleSources: 0,
          latestEligibleSequence: 4,
        },
      },
      { enabled: true }
    );
    expect(reported.summary).toContain('1 job(s) gave up');
    expect(reported.details?.join('\n')).toContain(
      '`orcaops knowledge status` lists the jobs that gave up and why; ' +
        '`orcaops knowledge reopen <job>` gives one a fresh attempt allowance at a terminal.'
    );
    expect(reported.details?.join('\n')).not.toContain('orcaops knowledge retry');
  });

  it('reports a database it cannot read without repairing it', async () => {
    await grant();
    const reported = await check(
      {
        problem: { code: 'upgrade_required', message: 'Preview it with `orcaops history upgrade`' },
        queue: null,
      },
      { enabled: true }
    );
    expect(reported.status).toBe('warn');
    expect(reported.details?.join('\n')).toContain('orcaops history upgrade');
  });
});
