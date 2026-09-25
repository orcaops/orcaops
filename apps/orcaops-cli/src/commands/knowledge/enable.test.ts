import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isatty } from 'node:tty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROCESSING_PROCESSOR_CONTRACT } from '@orcaops/core';
import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { knowledgeEnableAction } from './enable.js';
import { ErrorCodes } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { runInInvocationContext } from '../../lib/invocation-context.js';
import { processingGrantsFilePath } from '../../lib/knowledge-processing-grants.js';
import type { ProcessingHistory } from '../../lib/knowledge-processing-queue.js';
import { consentTerminal } from '../../lib/knowledge-processing-terminal.js';

vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: vi.fn(),
}));

let repo: TempRepo;
let configHome: string;
let previousConfigHome: string | undefined;
let stdout: string[];
let stderr: string[];

const configPath = (): string => path.join(repo.path, '.orcaops', 'config.json');
const grantsPath = (): string => processingGrantsFilePath(configHome);

async function writeConfig(knowledgeProcessing: Record<string, unknown> = {}): Promise<void> {
  await mkdir(path.dirname(configPath()), { recursive: true });
  await writeFile(
    configPath(),
    `${JSON.stringify(
      {
        schema_version: 6,
        install: { scope: 'project' },
        ...(Object.keys(knowledgeProcessing).length > 0
          ? { knowledge_processing: knowledgeProcessing, schema_version: 8 }
          : {}),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

/** A provider binary that answers `--version`, so availability is not the machine's. */
async function presentProvider(name: string): Promise<string> {
  const bin = path.join(repo.path, name);
  await rm(bin, { force: true });
  await symlink(process.execPath, bin);
  return bin;
}

const answers: string[] = [];
const asked: string[] = [];
/** Everything already on the terminal at the moment the question was put. */
const shownBeforeAsking: string[] = [];

function terminal(overrides: Partial<typeof consentTerminal> = {}) {
  return {
    isInteractive: () => true,
    ask: (question: string) => {
      asked.push(question);
      shownBeforeAsking.push(stderr.join(''));
      return Promise.resolve(answers.shift() ?? 'yes');
    },
    confirm: consentTerminal.confirm,
    ...overrides,
  };
}

const historyOf =
  (paused_jobs: number, latest: number | null, problem: ProcessingHistory['problem'] = null) =>
  (): Promise<ProcessingHistory> =>
    Promise.resolve({
      problem,
      backlog: { paused_jobs, latest_admitted_sequence: latest },
      queue: null,
      control: null,
      lease: null,
      usage: null,
      gaveUp: null,
      target: null,
      boundary: latest,
    });

async function enable(
  opts: Parameters<typeof knowledgeEnableAction>[0] = {},
  env: NodeJS.ProcessEnv = {}
): Promise<void> {
  const claude = await presentProvider('fake-claude');
  await runInInvocationContext(
    {
      cwd: repo.path,
      env: {
        ...process.env,
        ORCAOPS_CLAUDE_PATH: claude,
        ORCAOPS_CODEX_PATH: path.join(repo.path, 'absent-codex'),
        ...env,
      },
    },
    () => knowledgeEnableAction({ terminal: terminal(), ...opts })
  );
}

async function expectRefusal(promise: Promise<void>): Promise<string> {
  await expect(promise).rejects.toBeInstanceOf(CliExit);
  return stderr.join('');
}

beforeEach(async () => {
  vi.mocked(isatty).mockReturnValue(true);
  repo = await createTempRepo({ initialBranch: 'main' });
  configHome = await mkdtemp(path.join(tmpdir(), 'orcaops-knowledge-home-'));
  previousConfigHome = process.env.ORCAOPS_CONFIG_HOME;
  process.env.ORCAOPS_CONFIG_HOME = configHome;
  answers.length = 0;
  asked.length = 0;
  shownBeforeAsking.length = 0;
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
  await writeConfig();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousConfigHome === undefined) delete process.env.ORCAOPS_CONFIG_HOME;
  else process.env.ORCAOPS_CONFIG_HOME = previousConfigHome;
  await repo.cleanup();
  await rm(configHome, { recursive: true, force: true });
});

describe('orcaops knowledge enable', () => {
  it('shows the terms, records the grant, and only then turns the setting on', async () => {
    await enable();

    const shown = stderr.join('');
    expect(shown).toContain('Provider: claude, run on this machine.');
    expect(shown).toContain('Tool access: none.');
    expect(asked).toEqual(['Type "yes" to consent, anything else declines: ']);

    const store = JSON.parse(await readFile(grantsPath(), 'utf8')) as {
      grants: { provider: string; capability: string; source_scope: unknown; disclosed: unknown }[];
    };
    expect(store.grants).toHaveLength(1);
    expect(store.grants[0]).toMatchObject({
      capability: 'capture_content_llm_processing',
      provider: 'claude',
      processor_contract: PROCESSING_PROCESSOR_CONTRACT,
      source_scope: { admitted_after_sequence: 0, backlog: 'excluded' },
    });

    const written = JSON.parse(await readFile(configPath(), 'utf8')) as {
      schema_version: number;
      knowledge_processing: { enabled: boolean };
    };
    expect(written.knowledge_processing.enabled).toBe(true);
    expect(written.schema_version).toBe(8);
    expect(stdout.join('')).toContain('A background worker now runs after each capture');
  });

  it('records consent before configuration, and says so when the configuration write fails', async () => {
    const before = await readFile(configPath());
    await chmod(path.dirname(configPath()), 0o500);
    try {
      const message = await expectRefusal(enable());

      expect(message).toContain('Consent was recorded');
      expect(message).toContain('so knowledge processing is still off');
      expect(message).toContain('`orcaops knowledge enable` again to finish');
      expect(message).toContain('`orcaops knowledge revoke` to withdraw');
    } finally {
      await chmod(path.dirname(configPath()), 0o700);
    }

    expect(await readFile(configPath())).toEqual(before);
    const store = JSON.parse(await readFile(grantsPath(), 'utf8')) as { grants: unknown[] };
    expect(store.grants).toHaveLength(1);
  });

  it('records nothing and changes nothing when the answer is not the word', async () => {
    const before = await readFile(configPath());
    for (const answer of ['', 'n', 'no', 'y', 'YES please', 'ye']) {
      answers.push(answer);
      const message = await expectRefusal(enable());

      expect(message, answer).toContain('Declined: no consent was recorded');
      expect(await readFile(configPath()), answer).toEqual(before);
      await expect(readFile(grantsPath()), answer).rejects.toThrow(/ENOENT/);
    }
  });

  it('accepts the word whatever case or padding it arrives in', async () => {
    answers.push('  Yes \n');
    await enable();

    expect(JSON.parse(await readFile(grantsPath(), 'utf8')).grants).toHaveLength(1);
  });

  it('refuses without a terminal, never asking and never showing the terms', async () => {
    const before = await readFile(configPath());

    const message = await expectRefusal(
      enable({ terminal: terminal({ isInteractive: () => false }) })
    );

    expect(message).toContain('can only be given at an interactive terminal');
    expect(message).toContain('Run `orcaops knowledge enable` yourself in a terminal');
    expect(message).toContain('no flag, environment variable or non-interactive option grants it');
    expect(message).not.toContain('Provider: claude');
    expect(asked).toEqual([]);
    expect(await readFile(configPath())).toEqual(before);
    await expect(readFile(grantsPath())).rejects.toThrow(/ENOENT/);
  });

  it('refuses when the workload would be paused anyway, and leaves both files alone', async () => {
    await writeConfig({ provider: 'codex' });
    const before = await readFile(configPath());
    await presentProvider('absent-codex');

    const message = await expectRefusal(enable());

    expect(message).toContain('would still be paused with these settings');
    expect(message).toContain('cannot run with every tool disabled');
    expect(message).toContain('Nothing was recorded and nothing was changed.');
    expect(asked).toEqual([]);
    expect(await readFile(configPath())).toEqual(before);
    await expect(readFile(grantsPath())).rejects.toThrow(/ENOENT/);
  });

  it('records the backlog choice the person made', async () => {
    await enable({ includeBacklog: true, history: historyOf(4, 40) });

    const shown = stderr.join('');
    expect(shown).toContain('Existing captures: sent.');
    expect(shown).toContain('Already waiting: 4 jobs are admitted and waiting.');
    const { grants } = JSON.parse(await readFile(grantsPath(), 'utf8')) as {
      grants: { source_scope: unknown; disclosed: { paused_backlog_count: number } }[];
    };
    expect(grants[0].source_scope).toEqual({ admitted_after_sequence: 40, backlog: 'included' });
    expect(grants[0].disclosed.paused_backlog_count).toBe(4);
  });

  it('says the schema stamp moves, and what that costs teammates, before asking', async () => {
    await enable();

    expect(shownBeforeAsking[0]).toContain('moves the configuration schema from 6 to 8');
    expect(shownBeforeAsking[0]).toContain('every teammate on an older orcaops must upgrade');
  });

  it('still shows the terms and requires the word when the setting is already on', async () => {
    await writeConfig({ enabled: true });
    const before = await readFile(configPath());

    answers.push('no');
    await expectRefusal(enable());
    expect(stderr.join('')).toContain('Provider: claude, run on this machine.');
    await expect(readFile(grantsPath())).rejects.toThrow(/ENOENT/);

    await enable();
    expect(await readFile(configPath())).toEqual(before);
    expect(JSON.parse(await readFile(grantsPath(), 'utf8')).grants).toHaveLength(1);
    expect(stdout.join('')).toContain('was already true');
  });

  it('refuses a grant whose boundary the project database cannot name', async () => {
    const before = await readFile(configPath());

    const message = await expectRefusal(enable({ history: historyOf(2, null) }));

    expect(message).toContain('cannot say which admission sequence');
    expect(await readFile(configPath())).toEqual(before);
    await expect(readFile(grantsPath())).rejects.toThrow(/ENOENT/);
  });

  it('reports a refusal under --json without leaving the terms out of the terminal', async () => {
    answers.push('no');
    await expect(enable({ json: true })).rejects.toBeInstanceOf(CliExit);

    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.INVALID_INPUT },
    });
    expect(stderr.join('')).toContain('Provider: claude, run on this machine.');
  });
});
