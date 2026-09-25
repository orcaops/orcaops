import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isatty } from 'node:tty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { knowledgeDisableAction } from './disable.js';
import { knowledgeRevokeAction } from './revoke.js';
import { runInInvocationContext } from '../../lib/invocation-context.js';
import {
  InteractiveConsentConfirmation,
  listProcessingGrants,
  processingGrantsFilePath,
  type ProcessingGrantTerms,
  recordProcessingGrant,
} from '../../lib/knowledge-processing-grants.js';

vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: vi.fn(),
}));

let repo: TempRepo;
let configHome: string;
let previousConfigHome: string | undefined;
let stdout: string[];

const PROJECT_ID = '019606f0-0000-7000-8000-00000000000a';
const configPath = (): string => path.join(repo.path, '.orcaops', 'config.json');

const TERMS: ProcessingGrantTerms = {
  project_id: PROJECT_ID,
  provider: 'claude',
  processor_contract: 'knowledge-processor/1',
  source_scope: { admitted_after_sequence: 0, backlog: 'excluded' },
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

async function grant(changes: Partial<ProcessingGrantTerms> = {}): Promise<string> {
  const terms = { ...TERMS, ...changes };
  const { grant: recorded } = await recordProcessingGrant(terms, {
    repoRoot: repo.path,
    configDir: configHome,
    interactiveConfirmation: InteractiveConsentConfirmation.forTermsAcceptedAtTerminal(terms),
  });
  return recorded.grant_id;
}

const inForce = (): string[] =>
  listProcessingGrants({ repoRoot: repo.path, configDir: configHome })
    .entries.filter((entry) => entry.in_force)
    .map((entry) => entry.grant.grant_id);

function inRepo<T>(fn: () => Promise<T>): Promise<T> {
  return runInInvocationContext({ cwd: repo.path, env: { ...process.env } }, fn);
}

beforeEach(async () => {
  vi.mocked(isatty).mockReturnValue(true);
  repo = await createTempRepo({ initialBranch: 'main' });
  configHome = await mkdtemp(path.join(tmpdir(), 'orcaops-knowledge-off-'));
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

describe('orcaops knowledge disable', () => {
  it('turns the setting off and leaves the grant in force, saying how to withdraw it', async () => {
    const granted = await grant();
    await writeConfig({ enabled: true });

    await inRepo(() => knowledgeDisableAction());

    const written = JSON.parse(await readFile(configPath(), 'utf8')) as {
      knowledge_processing: { enabled: boolean };
    };
    expect(written.knowledge_processing.enabled).toBe(false);
    expect(inForce()).toEqual([granted]);
    expect(stdout.join('')).toContain('Your consent grant is untouched');
    expect(stdout.join('')).toContain('`orcaops knowledge revoke`');
  });

  it('writes nothing to a file that never carried the section', async () => {
    const before = await readFile(configPath());

    await inRepo(() => knowledgeDisableAction());

    expect(await readFile(configPath())).toEqual(before);
    expect(stdout.join('')).toContain('was already false');
  });
});

describe('orcaops knowledge revoke', () => {
  it('withdraws consent without a terminal and without touching configuration', async () => {
    const granted = await grant();
    await writeConfig({ enabled: true });
    const before = await readFile(configPath());
    vi.mocked(isatty).mockReturnValue(false);

    await inRepo(() => knowledgeRevokeAction({ json: true }));

    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: true,
      revoked_grant_ids: [granted],
      configuration_changed: false,
    });
    expect(await readFile(configPath())).toEqual(before);
    expect(inForce()).toEqual([]);
  });

  it('withdraws only the named provider when asked', async () => {
    const claude = await grant();
    const codex = await grant({ provider: 'codex' });

    await inRepo(() => knowledgeRevokeAction({ provider: 'codex' }));

    expect(inForce()).toEqual([claude]);
    expect(stdout.join('')).toContain('Revoked 1 consent grant(s) for codex');
    expect(stdout.join('')).toContain('Configuration was not changed.');
    expect(codex).not.toBe(claude);
  });

  it('keeps every withdrawn grant on record', async () => {
    const granted = await grant();

    await inRepo(() => knowledgeRevokeAction());

    const store = JSON.parse(await readFile(processingGrantsFilePath(configHome), 'utf8')) as {
      grants: { grant_id: string; revoked_at?: string }[];
    };
    expect(store.grants).toHaveLength(1);
    expect(store.grants[0]).toMatchObject({ grant_id: granted });
    expect(store.grants[0].revoked_at).toEqual(expect.any(String));
  });

  it('says plainly when there was nothing in force', async () => {
    await inRepo(() => knowledgeRevokeAction());

    expect(stdout.join('')).toContain('No consent grant was in force for this project.');
  });
});
