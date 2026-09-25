import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isatty } from 'node:tty';
import { describe, expect, it, vi } from 'vitest';

import { inputFile } from '@orcaops/test-harness';

import { knowledgeEnableAction } from '../../src/commands/knowledge/enable.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import {
  InteractiveConsentConfirmation,
  processingGrantsFilePath,
} from '../../src/lib/knowledge-processing-grants.js';
import { fixture } from '../helpers/database-history.js';
import { placeReleasedProjectDatabase } from '../helpers/released-project-database.js';
import { makeAgent } from '../support/test-agent.js';

// The confirmation an enable records demands this process's own standard input
// and output be a terminal; a test runner's are not.
vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: vi.fn(),
}));

/**
 * What `status` and `enable` read from the project database: the real queue on
 * a current one, a truthful refusal on one this build cannot read, and a grant
 * bounded by the sequence the database actually reports.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;

function env(f: Fixture, extra: Record<string, string> = {}) {
  return {
    ORCAOPS_ROOT: f.main,
    ORCAOPS_DATA_DIR: f.root,
    ORCAOPS_DISABLE_DRAIN: '1',
    CODEX_SESSION_ID: 'reading-session',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    TMUX_PANE: '',
    STY: '',
    WINDOW: '',
    TTY: '',
    XDG_STATE_HOME: f.temporary + '/unused-state',
    ...extra,
  };
}

function agent(f: Fixture) {
  return makeAgent({ cwd: f.main, timeoutMs: 120_000, env: env(f) });
}

async function writeConfig(f: Fixture, llm: Record<string, unknown> = { tool: 'none' }) {
  await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
  await writeFile(
    path.join(f.main, '.orcaops', 'config.json'),
    JSON.stringify({ schema_version: 6, install: { scope: 'project' }, llm }),
    'utf8'
  );
}

async function capturePlan(f: Fixture) {
  const raw = await agent(f).runRaw([
    'capture',
    'plan',
    '--no-llm',
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: `plan-${randomUUID()}`,
        task: 'Retain what a capture means',
        label: 'Reading the queue',
        plan_steps: [
          {
            text: 'report what is admitted',
            label: 'Reporting',
            acceptance_criteria: [{ text: 'the count is the database, not a placeholder' }],
          },
        ],
        touched_scope: ['storage'],
      })
    ),
  ]);
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return JSON.parse(raw.stdout) as Record<string, unknown>;
}

async function status(f: Fixture) {
  const raw = await agent(f).runRaw(['knowledge', 'status', '--json']);
  return { raw, data: JSON.parse(raw.stdout) as Record<string, unknown> };
}

describe('what status and enable read from the project database', { timeout: 180_000 }, () => {
  it('reports a neutral llm.tool none reason while processing is disabled', async () => {
    const f = await fixture();
    await writeConfig(f);

    const reported = await status(f);

    expect(reported.raw.exitCode, reported.raw.stdout + reported.raw.stderr).toBe(0);
    expect(reported.data.enabled).toBe(false);
    const reasons = reported.data.pause_reasons as { code: string; message: string }[];
    const reason = reasons.find((entry) => entry.code === 'llm_tool_none');
    expect(reason?.message).toContain(
      'turns off every model call, so knowledge processing cannot run with these settings.'
    );
    expect(reason?.message).not.toContain('even though it is enabled');
  });

  it('reports nothing admitted when the project has no database yet', async () => {
    const f = await fixture();
    await writeConfig(f);
    const reported = await status(f);
    expect(reported.raw.exitCode, reported.raw.stdout + reported.raw.stderr).toBe(0);
    expect(reported.data).toMatchObject({
      backlog: { paused_jobs: 0, latest_admitted_sequence: null },
      queue: { jobs: { pending: 0 } },
      history_problem: null,
    });
  });

  it('reports the real queue once captures have been admitted', async () => {
    const f = await fixture();
    await writeConfig(f);
    await capturePlan(f);
    const reported = await status(f);
    expect(reported.data).toMatchObject({
      backlog: { paused_jobs: 1 },
      queue: { jobs: { pending: 1 }, openAttempts: 0 },
      control: null,
      lease: null,
    });
    expect(
      (reported.data.backlog as { latest_admitted_sequence: number }).latest_admitted_sequence
    ).toBeGreaterThan(0);
  });

  it('says the released database needs its explicit upgrade, and upgrades nothing', async () => {
    const f = await fixture();
    await writeConfig(f);
    const databasePath = f.writer.databasePath;
    await placeReleasedProjectDatabase(f.writer);
    const before = await readFile(databasePath);

    const reported = await status(f);
    expect(reported.raw.exitCode, reported.raw.stdout + reported.raw.stderr).toBe(0);
    expect(reported.data.history_problem).toMatchObject({ code: 'upgrade_required' });
    expect((reported.data.history_problem as { message: string }).message).toContain(
      'orcaops history upgrade'
    );
    expect(reported.data).toMatchObject({
      backlog: { paused_jobs: 0, latest_admitted_sequence: null },
      queue: null,
    });
    expect(await readFile(databasePath)).toEqual(before);
  });

  it('bounds a from-now-on grant at the sequence the database reports, and includes the backlog on request', async () => {
    const f = await fixture();
    await writeConfig(f, { tool: 'claude' });
    await capturePlan(f);
    const reported = await status(f);
    const admitted = (reported.data.backlog as { latest_admitted_sequence: number })
      .latest_admitted_sequence;

    const shown: string[] = [];
    // The grant store resolves its directory from this process's own environment,
    // which the suite has already pointed at a throwaway config home.
    const configHome = process.env.ORCAOPS_CONFIG_HOME!;
    const claude = path.join(f.temporary, 'fake-claude');
    await symlink(process.execPath, claude);
    const terminal = {
      isInteractive: () => true,
      ask: () => Promise.resolve('yes'),
      confirm: InteractiveConsentConfirmation.forTermsAcceptedAtTerminal.bind(
        InteractiveConsentConfirmation
      ),
    };
    vi.mocked(isatty).mockReturnValue(true);
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      shown.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const enable = (includeBacklog: boolean) =>
      runInInvocationContext(
        {
          cwd: f.main,
          env: {
            ...process.env,
            ...env(f),
            ORCAOPS_CLAUDE_PATH: claude,
            ORCAOPS_CODEX_PATH: path.join(f.temporary, 'absent-codex'),
          },
        },
        () => knowledgeEnableAction({ terminal, json: true, includeBacklog })
      );
    try {
      await enable(false);
      await enable(true);
    } finally {
      process.stderr.write = write;
      vi.mocked(isatty).mockReset();
    }

    expect(shown.join('')).toContain('Already waiting: 1 job is admitted and waiting.');
    expect(shown.join('')).toContain('Existing captures: sent.');
    const { grants } = JSON.parse(await readFile(processingGrantsFilePath(configHome), 'utf8')) as {
      grants: { source_scope: { admitted_after_sequence: number; backlog: string } }[];
    };
    expect(grants.map((grant) => grant.source_scope)).toEqual([
      { admitted_after_sequence: admitted, backlog: 'excluded' },
      { admitted_after_sequence: admitted, backlog: 'included' },
    ]);
  });
});
