import { Repo } from '@orcaops/core';
import {
  copyDatabaseAuthoredValue,
  refuseDatabaseAuthoredSecrets,
  type RegisteredDatabaseContext,
  requireDatabaseExecutionContext,
  setupProjectDatabase,
} from '@orcaops/core/history/database-capture';
import { HistoryScopeError, unavailableProjectError } from '@orcaops/project-scope/history';
import type { Config } from '@orcaops/storage';
import {
  type DatabaseJson,
  openProjectDatabase,
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
} from '@orcaops/storage/history/database';

import { resolveDatabaseHistoryCommandContext } from './database-history-context.js';
import { closeFailedHistoryRead } from './history-reader-close.js';
import { getInvocationEnv, getInvocationInvokedByAgent } from './invocation-context.js';
import { type InvokingAgentResolution, resolveInvokingAgent } from './invoking-agent.js';

export interface DatabaseSeedCommandContext {
  repoRoot: string;
  config: Config;
  repo: Repo;
  database: ProjectDatabase;
  registered: RegisteredDatabaseContext | null;
  invokingAgent: InvokingAgentResolution;
  operationOptions: ProjectOperationOptions;
  close(): void;
}

export async function resolveDatabaseSeedCommandContext(options: {
  write: boolean;
  initialize?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onWait?: () => void;
  authoredPayloads?: readonly unknown[];
  beforeWrite?: (input: {
    repoRoot: string;
    config: Config;
    database: ProjectDatabase | null;
  }) => Promise<void>;
}): Promise<DatabaseSeedCommandContext> {
  const env = { ...(options.env ?? getInvocationEnv()) };
  const context = await resolveDatabaseHistoryCommandContext({
    profile: 'exact',
    cwd: options.cwd,
    env,
  });
  try {
    const authoredPayloads = copyDatabaseAuthoredValue(
      options.authoredPayloads ?? []
    ) as DatabaseJson[];
    refuseDatabaseAuthoredSecrets(authoredPayloads, context.config.redact.allow, 'setup');
    const operationOptions: ProjectOperationOptions = {
      signal: options.signal,
      onWait: options.onWait,
    };
    const { scope } = context;
    const selected = scope.projects[0];
    if (options.write && scope.gitContext) {
      if (options.signal?.aborted)
        throw new ProjectDatabaseError('CANCELLED', 'Seed cancelled before writer preparation');
      await options.beforeWrite?.({
        repoRoot: scope.gitContext.worktreeRoot,
        config: context.config,
        database: selected?.database ?? null,
      });
    }
    if (scope.projects.length === 0 && options.initialize && scope.gitContext) {
      const setup = await setupProjectDatabase(
        {
          cwd: scope.gitContext.worktreeRoot,
          root: scope.root.resolvedRoot,
          authoredPayloads,
          secretAllow: [...context.config.redact.allow],
        },
        { signal: options.signal, onWait: options.onWait }
      );
      scope.close();
      if (setup.status !== 'complete')
        throw new HistoryScopeError(
          'HISTORY_MISSING',
          'Project history initialization is incomplete; retry seed after setup finishes'
        );
      return resolveDatabaseSeedCommandContext({
        ...options,
        initialize: false,
        beforeWrite: undefined,
        env,
      });
    }
    if (
      scope.projects.length !== 1 ||
      !selected?.authority ||
      !selected.database ||
      !scope.gitContext
    )
      throw unavailableProjectError(selected?.completeness.issues ?? [], {
        code: 'HISTORY_MISSING',
        message: 'Seed requires one registered repository and available project history',
      });
    const repo = new Repo(scope.gitContext.worktreeRoot, {
      env: {
        ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_'))),
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1',
      },
    });
    if (!options.write) {
      return {
        repoRoot: scope.gitContext.worktreeRoot,
        config: context.config,
        repo,
        database: selected.database,
        registered: null,
        invokingAgent: resolveInvokingAgent({ flag: getInvocationInvokedByAgent(), env }),
        operationOptions,
        close: () => scope.close(),
      };
    }
    const repoRoot = scope.gitContext.worktreeRoot;
    if (options.signal?.aborted)
      throw new ProjectDatabaseError('CANCELLED', 'Seed cancelled before opening the writer');
    const registered = await requireDatabaseExecutionContext(
      {
        cwd: repoRoot,
        root: selected.authority.resolvedRoot,
        projectId: selected.authority.projectId,
      },
      { signal: options.signal }
    );
    const writer = await openProjectDatabase({
      authority: selected.authority,
      mode: 'writer',
      signal: options.signal,
    });
    if (options.signal?.aborted) {
      closeFailedHistoryRead(writer);
      throw new ProjectDatabaseError('CANCELLED', 'Seed cancelled while opening the writer');
    }
    scope.close();
    return {
      repoRoot,
      config: context.config,
      repo,
      database: writer,
      registered,
      invokingAgent: resolveInvokingAgent({ flag: getInvocationInvokedByAgent(), env }),
      operationOptions,
      close: () => writer.close(),
    };
  } catch (cause) {
    closeFailedHistoryRead(context.scope);
    throw cause;
  }
}
