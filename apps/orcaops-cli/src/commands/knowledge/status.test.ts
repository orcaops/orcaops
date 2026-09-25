import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isatty } from 'node:tty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROCESSING_PROCESSOR_CONTRACT } from '@orcaops/core';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { knowledgeStatusAction, type KnowledgeStatusOptions } from './status.js';
import { runInInvocationContext } from '../../lib/invocation-context.js';
import type { ProcessingConsentDecision } from '../../lib/knowledge-processing-consent.js';
import {
  InteractiveConsentConfirmation,
  type ProcessingGrantTerms,
  recordProcessingGrant,
} from '../../lib/knowledge-processing-grants.js';
import type {
  ProcessingHistory,
  ProcessingHistoryRequest,
} from '../../lib/knowledge-processing-queue.js';

vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: vi.fn(),
}));

let repo: TempRepo;
let configHome: string;
let previousConfigHome: string | undefined;
let stdout: string[];

const configPath = (): string => path.join(repo.path, '.orcaops', 'config.json');
const PROJECT_ID = '019606f0-0000-7000-8000-00000000000a';

const TERMS: ProcessingGrantTerms = {
  project_id: PROJECT_ID,
  provider: 'claude',
  processor_contract: PROCESSING_PROCESSOR_CONTRACT,
  source_scope: { admitted_after_sequence: 0, backlog: 'excluded' },
  disclosed: {
    tool_access: 'none',
    model: { selection: 'provider_default' },
    limits: {
      max_cost_usd_per_call: { usd: 0.5, holds: 'best_effort' },
      max_cost_usd_per_day: 'none',
      max_calls_per_hour: 60,
      max_input_bytes: 131_072,
      max_output_bytes: 65_536,
    },
    paused_backlog_count: 0,
  },
};

async function writeConfig(knowledgeProcessing?: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(configPath()), { recursive: true });
  await writeFile(
    configPath(),
    `${JSON.stringify(
      knowledgeProcessing === undefined
        ? { schema_version: 6, install: { scope: 'project' } }
        : {
            schema_version: 8,
            install: { scope: 'project' },
            knowledge_processing: knowledgeProcessing,
          },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function presentClaude(): Promise<string> {
  const bin = path.join(repo.path, 'fake-claude');
  await rm(bin, { force: true });
  await symlink(process.execPath, bin);
  return bin;
}

async function grant(changes: Partial<ProcessingGrantTerms> = {}): Promise<void> {
  const terms = { ...TERMS, ...changes };
  await recordProcessingGrant(terms, {
    repoRoot: repo.path,
    configDir: configHome,
    interactiveConfirmation: InteractiveConsentConfirmation.forTermsAcceptedAtTerminal(terms),
  });
}

interface StatusReport {
  ok: true;
  enabled: boolean;
  configuration_source: { kind: string; path: string };
  coverage: {
    enabled: boolean;
    configuration_source: { kind: string; path: string };
    history_problem: unknown;
    claim: string;
    completed_through: number | null;
  };
  project_id: string | null;
  settings: { provider: { id: string }; limits: Record<string, unknown> } | null;
  pause_reasons: { code: string }[];
  consent: ProcessingConsentDecision | null;
  backlog: { paused_jobs: number; latest_admitted_sequence: number | null };
  history_problem: unknown;
  lease: { ownerId: string | null; ownerGeneration: number; expiresAt: string | null } | null;
  lease_expired: boolean;
}

function historyWith(overrides: Partial<ProcessingHistory>): ProcessingHistory {
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

async function status(
  json = true,
  history?: KnowledgeStatusOptions['history'],
  now?: KnowledgeStatusOptions['now'],
  limit?: number
): Promise<StatusReport> {
  const claude = await presentClaude();
  await runInInvocationContext(
    {
      cwd: repo.path,
      env: {
        ...process.env,
        ORCAOPS_CLAUDE_PATH: claude,
        ORCAOPS_CODEX_PATH: path.join(repo.path, 'absent-codex'),
      },
    },
    () =>
      knowledgeStatusAction({
        json,
        ...(history === undefined ? {} : { history }),
        ...(now === undefined ? {} : { now }),
        ...(limit === undefined ? {} : { limit }),
      })
  );
  return json ? (JSON.parse(stdout.join('')) as StatusReport) : ({} as StatusReport);
}

beforeEach(async () => {
  vi.mocked(isatty).mockReturnValue(true);
  repo = await createTempRepo({ initialBranch: 'main' });
  configHome = await mkdtemp(path.join(tmpdir(), 'orcaops-knowledge-status-'));
  previousConfigHome = process.env.ORCAOPS_CONFIG_HOME;
  process.env.ORCAOPS_CONFIG_HOME = configHome;
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await writeConfig();
  execFileSync('git', ['config', '--local', 'orcaops.projectid', PROJECT_ID], { cwd: repo.path });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousConfigHome === undefined) delete process.env.ORCAOPS_CONFIG_HOME;
  else process.env.ORCAOPS_CONFIG_HOME = previousConfigHome;
  await repo.cleanup();
  await rm(configHome, { recursive: true, force: true });
});

describe('orcaops knowledge status', () => {
  it('reports a checked-in enabled: true with no grant as not consented', async () => {
    await writeConfig({ enabled: true });

    const report = await status();

    expect(report.enabled).toBe(true);
    expect(report.settings?.provider.id).toBe('claude');
    expect(report.consent).toMatchObject({ ok: false, code: 'CONSENT_DENIED', reason: 'no_grant' });
  });

  it('reports a grant that covers settings configuration has not turned on', async () => {
    await grant();

    const report = await status();

    expect(report.enabled).toBe(false);
    expect(report.consent).toMatchObject({ ok: true });
    expect(report.settings?.limits).toMatchObject({
      max_cost_usd_per_call: { usd: 0.5, holds: 'best_effort' },
    });
  });

  it('denies once an effective limit is looser than the one disclosed', async () => {
    await grant();
    await writeConfig({ enabled: true, max_cost_usd_per_call: 'none' });

    const report = await status();

    expect(report.consent).toMatchObject({
      ok: false,
      reason: 'limits_wider_than_disclosed',
      message: expect.stringContaining('max_cost_usd_per_call'),
    });
  });

  it('does not let another project’s grant cover this one', async () => {
    await grant({ project_id: '019606f0-0000-7000-8000-00000000000b' });

    const report = await status();

    expect(report.consent).toMatchObject({ ok: false, reason: 'other_project' });
  });

  it('reports the reasons a turned-on workload would still be paused', async () => {
    await writeConfig({ enabled: true, provider: 'codex' });

    const report = await status();

    expect(report.settings).toBeNull();
    expect(report.pause_reasons.map((reason) => reason.code)).toContain(
      'no_tool_execution_unenforced'
    );
    expect(report.consent).toBeNull();
  });

  it('reports an input cap below the floor among those reasons', async () => {
    await writeConfig({ enabled: true, max_input_bytes: 20_000 });

    const report = await status();

    expect(report.pause_reasons.map((reason) => reason.code)).toContain('input_cap_below_floor');
  });

  it('starts nothing, prompts for nothing and leaves both files alone', async () => {
    await grant();
    const config = await readFile(configPath());
    const grants = await readFile(path.join(configHome, 'knowledge-processing-grants.json'));

    await status();

    expect(await readFile(configPath())).toEqual(config);
    expect(await readFile(path.join(configHome, 'knowledge-processing-grants.json'))).toEqual(
      grants
    );
  });

  it('points at enable only while processing is off or consent does not cover it', async () => {
    const hint = 'Run `orcaops knowledge enable`';
    await status(false);
    expect(stdout.join('')).toContain(hint);

    stdout = [];
    await grant();
    await writeConfig({ enabled: true });
    await status(false);
    expect(stdout.join('')).toContain('Consent: granted');
    expect(stdout.join('')).not.toContain(hint);
  });

  it('says who holds the worker lease', async () => {
    const held = {
      ownerId: 'pid-4242.start-1756684800000.9f1c',
      ownerGeneration: 7,
      acquiredAt: '2026-09-01T00:00:00.000Z',
      renewedAt: '2026-09-01T00:00:05.000Z',
      expiresAt: '2026-09-01T00:00:20.000Z',
    };

    const beforeExpiry = () => new Date('2026-09-01T00:00:10.000Z');

    const report = await status(
      true,
      () => Promise.resolve(historyWith({ lease: held })),
      beforeExpiry
    );
    expect(report.lease).toEqual(held);
    expect(report.lease_expired).toBe(false);

    stdout = [];
    await status(false, () => Promise.resolve(historyWith({ lease: held })), beforeExpiry);
    const text = stdout.join('');
    expect(text).toContain(`Worker lease: held by ${held.ownerId} (generation 7)`);
    expect(text).toContain('expires 2026-09-01T00:00:20.000Z');
  });

  it('reports a lease whose owner stopped renewing it as expired, not held', async () => {
    const stale = {
      ownerId: 'pid-4242.start-1756684800000.9f1c',
      ownerGeneration: 3,
      acquiredAt: '2026-09-01T00:00:00.000Z',
      renewedAt: '2026-09-01T00:00:05.000Z',
      expiresAt: '2026-09-01T00:00:20.000Z',
    };
    const afterExpiry = () => new Date('2026-09-01T00:00:45.000Z');

    const report = await status(
      true,
      () => Promise.resolve(historyWith({ lease: stale })),
      afterExpiry
    );
    expect(report.lease).toEqual(stale);
    expect(report.lease_expired).toBe(true);

    stdout = [];
    await status(false, () => Promise.resolve(historyWith({ lease: stale })), afterExpiry);
    const text = stdout.join('');
    expect(text).not.toContain('Worker lease: held by');
    expect(text).toContain(
      `Worker lease: expired at 2026-09-01T00:00:20.000Z (last held by ${stale.ownerId}, ` +
        'generation 3); the next worker takes it.'
    );
  });

  it('says seeded or imported history never joins the queue when nothing is admitted', async () => {
    await status(false, () => Promise.resolve(historyWith({})));

    const text = stdout.join('');
    expect(text).toContain('Queue: nothing has been admitted for processing yet.');
    expect(text).toContain(
      'Seeded, imported and converted history is never queued, and neither replaying a ' +
        'capture nor restoring a backup queues anything new'
    );
  });

  it('says the worker lease is not held, and what starts one', async () => {
    const free = {
      ownerId: null,
      ownerGeneration: 3,
      acquiredAt: null,
      renewedAt: null,
      expiresAt: null,
    };

    const report = await status(true, () => Promise.resolve(historyWith({ lease: free })));
    expect(report.lease).toEqual(free);

    stdout = [];
    await status(false, () => Promise.resolve(historyWith({ lease: free })));
    expect(stdout.join('')).toContain('Worker lease: not held.');
  });

  describe('jobs that gave up', () => {
    const gaveUpJob = (day: number) => ({
      job: {
        jobId: `job-${day}`,
        updatedAt: `2026-09-0${day}T00:00:00.000Z`,
        result: { outcome: 'attempts_exhausted', attempts: 3, max_attempts: 3 },
      },
      lastAttemptDetail: { call: { code: 'PROVIDER_FAILED', message: 'upstream 503' } },
    });
    const requested: ProcessingHistoryRequest[] = [];
    const withGaveUp = (request: ProcessingHistoryRequest) => {
      requested.push(request);
      return Promise.resolve(
        historyWith({
          backlog: { paused_jobs: 0, latest_admitted_sequence: 4 },
          gaveUp: {
            total: 3,
            jobs: [gaveUpJob(3), gaveUpJob(2)],
          } as unknown as ProcessingHistory['gaveUp'],
        })
      );
    };
    beforeEach(() => {
      requested.length = 0;
    });

    it('lists why each gave up, how to reopen one, and how to list more', async () => {
      await status(false, withGaveUp, undefined, 2);

      expect(requested[0]).toMatchObject({ gaveUpLimit: 2 });
      const text = stdout.join('');
      expect(text).toContain(
        '  Gave up: 3 job(s). Run `orcaops knowledge reopen <job>` at a terminal to give one a ' +
          'fresh attempt allowance:'
      );
      expect(text).toContain(
        '    job-3 (2026-09-03T00:00:00.000Z): It spent its allowance of 3 attempt(s); on the ' +
          'last one the provider call failed with PROVIDER_FAILED: upstream 503.'
      );
      expect(text).toContain('    job-2 (2026-09-02T00:00:00.000Z)');
      expect(text).toContain(
        '    …and 1 more; `orcaops knowledge status --limit <n>` lists more of them.'
      );
    });

    it('reads five unless asked for more, and carries each with its reason in JSON', async () => {
      const report = await status(true, withGaveUp);

      expect(requested[0]).toMatchObject({ gaveUpLimit: 5 });
      expect(report).toMatchObject({
        gave_up: {
          total: 3,
          jobs: [
            {
              job_id: 'job-3',
              gave_up_at: '2026-09-03T00:00:00.000Z',
              reason: expect.stringContaining('PROVIDER_FAILED'),
              last_attempt_detail: { call: { code: 'PROVIDER_FAILED' } },
            },
            { job_id: 'job-2' },
          ],
        },
      });
    });

    it('refuses a --limit that is not a positive whole number', async () => {
      await expect(status(true, withGaveUp, undefined, 0)).rejects.toThrow();

      expect(stdout.join('')).toContain('--limit must be a positive integer.');
      expect(requested).toEqual([]);
    });
  });

  it('calls a source still being interpreted progress, not a failure', async () => {
    await status(false, () =>
      Promise.resolve(
        historyWith({
          queue: {
            jobs: {
              pending: 0,
              running: 0,
              completed: 0,
              retryable_failure: 1,
              terminal_failure: 0,
            },
            waiting: [{ waitReason: 'source_chunk_pending', jobs: 1, nextRetryAt: null }],
            awaitingModelResume: 0,
            openAttempts: 0,
            latestAdmittedSequence: 4,
            eligibleSources: 1,
            missingEligibleSources: 0,
            latestEligibleSequence: 4,
          },
        })
      )
    );

    const text = stdout.join('');
    expect(text).toContain('Partly interpreted, more of the source to come: 1 job(s)');
    expect(text).not.toContain('Waiting on source_chunk_pending');
  });

  it('carries the one coverage field, agreeing with what it prints beside it', async () => {
    const report = await status();

    expect(report.coverage).toMatchObject({
      enabled: report.enabled,
      configuration_source: report.configuration_source,
      history_problem: report.history_problem,
      completed_through: null,
    });
    // Processing is off in this repository, so nothing it says may read as complete.
    expect(report.coverage.claim).not.toBe('complete');

    stdout = [];
    await status(false);
    expect(stdout.join('')).toContain(`Coverage: ${report.coverage.claim.replaceAll('_', ' ')}.`);
    expect(stdout.join('')).toContain('claims no completeness');
  });

  it('says in its human output that nothing processes yet', async () => {
    await status(false);

    const text = stdout.join('');
    expect(text).toContain('Knowledge processing: off.');
    expect(text).toContain('A background worker starts after a capture when processing is on');
    expect(text).toContain('a call-count limit is not a dollar limit');
  });
});
