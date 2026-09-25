// One repository, one project database and one user-local config home for a whole workflow.
//
// A workflow's stages are separate `it`s that read what the stage before them wrote, so the root
// belongs to the file rather than to a test: `tests/helpers/database-history.ts` removes its
// fixture in an `afterEach`, which would take the database away between two stages. Everything a
// stage touches is real except the provider, which is a script that records what it was asked for.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { requireDatabaseExecutionContext } from '@orcaops/core/history/database-checkout';
import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import {
  openProjectDatabase,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
} from '@orcaops/storage/history/database';
import type { CliResult } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

const execute = promisify(execFile);

/** The scripted proposer the worker's own fixtures answer with; never a paid provider. */
export const KNOWLEDGE_PROPOSER = fileURLToPath(
  new URL('../../src/knowledge-worker/fixtures/fake-knowledge-proposer.mjs', import.meta.url)
);

export interface ScenarioWorkflowOptions {
  /**
   * Register the project database up front. A workflow that starts at `init` leaves it off, so
   * the store is the one the first capture creates.
   */
  database?: boolean;
  /** What the fake provider runs when something actually calls it. */
  provider?: string;
}

export interface ScenarioWorkflow {
  temporary: string;
  repoPath: string;
  dataRoot: string;
  configHome: string;
  providerPath: string;
  /** The binary the fake provider stands in for, as configuration names it. */
  env(extra?: Record<string, string>): Record<string, string>;
  run(
    args: readonly string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ): Promise<CliResult>;
  /** A `--json` command that must succeed, as its parsed envelope. */
  json(
    args: readonly string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ): Promise<Record<string, unknown>>;
  authority(): Promise<ProjectDatabaseAuthority>;
  /** A fresh writer connection; the workflow closes every one it handed out. */
  open(): Promise<ProjectDatabase>;
  closeConnections(): void;
  /** Every prepared-input call the provider was asked to make, newest last. */
  providerCalls(): string[];
  /** Every availability probe, which is a `--version` run and not a model call. */
  providerProbes(): string[];
  /**
   * A document for `--input`, written as it stands. `inputFile` from the harness fills a capture's
   * idempotency key in, which every other document the CLI reads refuses as an unknown field.
   */
  inputDocument(value: unknown): Promise<string>;
  addWorktree(name: string, config?: Record<string, unknown>): Promise<string>;
  writeConfig(document: Record<string, unknown>, at?: string): Promise<string>;
  cleanup(): Promise<void>;
}

async function writeProviderScript(at: string, log: string, target: string): Promise<string> {
  const file = path.join(at, 'cli.js');
  await writeFile(
    path.join(at, 'package.json'),
    JSON.stringify({
      name: '@anthropic-ai/claude-code',
      type: 'module',
      bin: { claude: 'cli.js' },
    })
  );
  await writeFile(
    file,
    [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      // An availability probe is not a call, and the two are recorded apart so a workflow can
      // say that nothing was ever asked to interpret anything.
      `if (process.argv.includes('--version')) { appendFileSync(${JSON.stringify(log)}, 'probe\\n');` +
        ' console.log("1.0.0-fake"); process.exit(0); }',
      `appendFileSync(${JSON.stringify(log)}, 'call ' + process.argv.slice(2).join(' ') + '\\n');`,
      `await import(${JSON.stringify(target)});`,
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  await chmod(file, 0o755);
  return file;
}

export async function scenarioWorkflow(
  options: ScenarioWorkflowOptions = {}
): Promise<ScenarioWorkflow> {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'orcaops-scenario-')));
  const repoPath = path.join(temporary, 'repo');
  const configHome = path.join(temporary, 'config');
  const providerLog = path.join(temporary, 'provider-log');
  for (const directory of [repoPath, configHome, path.join(temporary, 'state')])
    await mkdir(directory, { recursive: true });
  await execute('git', ['-C', repoPath, 'init', '-qb', 'main']);
  await execute('git', ['-C', repoPath, 'config', '--local', 'user.name', 'Test']);
  await execute('git', ['-C', repoPath, 'config', '--local', 'user.email', 'test@example.test']);
  await execute('git', ['-C', repoPath, 'commit', '--allow-empty', '-qm', 'Initial']);

  const providerPath = await writeProviderScript(
    temporary,
    providerLog,
    options.provider ?? KNOWLEDGE_PROPOSER
  );
  // The grant store resolves its home from this process's own environment, as it does for a
  // worker that inherited it from the capture that woke one.
  const previousConfigHome = process.env.ORCAOPS_CONFIG_HOME;
  process.env.ORCAOPS_CONFIG_HOME = configHome;

  const requestedRoot = path.join(temporary, 'data');
  let registeredRoot: string | null = null;
  if (options.database === true) {
    const setup = await setupProjectDatabase({
      cwd: repoPath,
      root: requestedRoot,
      authoredPayloads: [],
      secretAllow: [],
    });
    if (setup.status !== 'complete') throw new Error('the scenario database was not registered');
    registeredRoot = setup.initialization.authority.resolvedRoot;
    // The repository's own identity, which `init` and the first capture write for a person.
    // Without it a later verb mints a second one and the store refuses it as another project.
    await execute('git', [
      '-C',
      repoPath,
      'config',
      'orcaops.projectid',
      setup.initialization.authority.projectId,
    ]);
  }
  const dataRoot = registeredRoot ?? requestedRoot;

  const handles: ProjectDatabase[] = [];
  let documents = 0;
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    ORCAOPS_ROOT: repoPath,
    ORCAOPS_DATA_DIR: dataRoot,
    ORCAOPS_CONFIG_HOME: configHome,
    ORCAOPS_GLOBAL_ROOT: path.join(temporary, 'global'),
    ORCAOPS_DISABLE_DRAIN: '1',
    ORCAOPS_CLAUDE_PATH: providerPath,
    ORCAOPS_CODEX_PATH: path.join(temporary, 'absent-codex'),
    CODEX_SESSION_ID: 'scenario-session',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    TMUX_PANE: '',
    STY: '',
    WINDOW: '',
    TTY: '',
    XDG_STATE_HOME: path.join(temporary, 'state'),
    ...extra,
  });

  const run: ScenarioWorkflow['run'] = (args, opts = {}) =>
    makeAgent({
      cwd: opts.cwd ?? repoPath,
      timeoutMs: 120_000,
      env: env(opts.env),
    }).runRaw([...args]);

  const providerLines = (): string[] => {
    try {
      return readFileSync(providerLog, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };

  return {
    temporary,
    repoPath,
    dataRoot,
    configHome,
    providerPath,
    env,
    run,
    json: async (args, opts) => {
      const raw = await run(args, opts);
      const parsed = JSON.parse(raw.stdout) as Record<string, unknown>;
      if (raw.exitCode !== 0 || parsed.ok !== true)
        throw new Error(`${args.join(' ')} failed: ${raw.stdout}${raw.stderr}`);
      return parsed;
    },
    authority: async () =>
      (await requireDatabaseExecutionContext({ cwd: repoPath, root: dataRoot })).authority,
    open: async () => {
      const context = await requireDatabaseExecutionContext({ cwd: repoPath, root: dataRoot });
      const handle = await openProjectDatabase({ authority: context.authority, mode: 'writer' });
      handles.push(handle);
      return handle;
    },
    closeConnections: () => {
      for (const handle of handles.splice(0)) {
        try {
          handle.close();
        } catch {
          /* A closed connection must not block the next stage. */
        }
      }
    },
    providerCalls: () => providerLines().filter((line) => line.startsWith('call ')),
    providerProbes: () => providerLines().filter((line) => line === 'probe'),
    inputDocument: async (value) => {
      const file = path.join(temporary, 'inputs', `document-${documents++}.json`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      return file;
    },
    addWorktree: async (name, config) => {
      const worktree = path.join(temporary, name);
      await execute('git', ['-C', repoPath, 'worktree', 'add', '-qb', name, worktree]);
      const resolved = await realpath(worktree);
      if (config !== undefined) await writeConfigAt(resolved, config);
      return resolved;
    },
    writeConfig: (document, at) => writeConfigAt(at ?? repoPath, document),
    cleanup: async () => {
      for (const handle of handles.splice(0)) {
        try {
          handle.close();
        } catch {
          /* A closed connection must not block removing the root. */
        }
      }
      if (previousConfigHome === undefined) delete process.env.ORCAOPS_CONFIG_HOME;
      else process.env.ORCAOPS_CONFIG_HOME = previousConfigHome;
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

async function writeConfigAt(root: string, document: Record<string, unknown>): Promise<string> {
  const file = path.join(root, '.orcaops', 'config.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return file;
}
