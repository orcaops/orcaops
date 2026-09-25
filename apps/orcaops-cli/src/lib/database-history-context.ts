import path from 'node:path';

import { configFromSource, resolveConfigSource, type ResolvedConfigSource } from '@orcaops/core';
import {
  type HistoryProfile,
  type HistorySelector,
  validateHistorySelector,
} from '@orcaops/project-scope/history';
import {
  type DatabaseHistoryScope,
  resolveDatabaseHistoryScope,
} from '@orcaops/project-scope/history/database';
import { type Config, getDefaultConfig } from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';

import { closeFailedHistoryRead } from './history-reader-close.js';
import {
  getInvocationCwd,
  getInvocationEnv,
  getInvocationRootOverride,
} from './invocation-context.js';

export interface DatabaseHistoryContextOptions {
  profile: HistoryProfile;
  selector?: HistorySelector;
  gitRange?: string;
  cwd?: string;
  checkoutRoot?: string;
  dataRoot?: string;
  cacheRoot?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface DatabaseHistoryCommandContext {
  scope: DatabaseHistoryScope;
  config: Config;
  /**
   * The file the configuration came from; null outside a checkout, where nothing governs it.
   * Optional so a caller that composes a context out of a scope and a configuration alone still
   * satisfies this shape.
   */
  configSource?: ResolvedConfigSource | null;
}

export async function resolveDatabaseHistoryCommandContext(
  options: DatabaseHistoryContextOptions
): Promise<DatabaseHistoryCommandContext> {
  const input = structuredClone(options);
  validateHistorySelector(input);
  const cwd = path.resolve(input.cwd ?? getInvocationCwd());
  const env = { ...(input.env ?? getInvocationEnv()) };
  const override = input.checkoutRoot ?? getInvocationRootOverride() ?? env.ORCAOPS_ROOT;
  const home = input.home === undefined ? undefined : path.resolve(cwd, input.home);
  if (env.HOME) env.HOME = path.resolve(cwd, env.HOME);
  const root = await normalizeHistoryRoot({ root: input.dataRoot, env, home, cwd });
  const scope = await resolveDatabaseHistoryScope({
    profile: input.profile,
    selector: input.selector,
    gitRange: input.gitRange,
    cwd: override?.trim() ? path.resolve(cwd, override) : cwd,
    root: root.resolvedRoot,
    cacheRoot: input.cacheRoot === undefined ? undefined : path.resolve(cwd, input.cacheRoot),
    env,
    home,
  });
  try {
    const git = scope.gitContext;
    // The file the configuration came from, kept beside the configuration itself: a surface that
    // has to name where a setting is governed from would otherwise resolve it a second time.
    const configSource = git
      ? await resolveConfigSource(git.worktreeRoot, { commonDir: git.commonDir })
      : null;
    return {
      scope,
      config: configSource ? configFromSource(configSource) : getDefaultConfig(),
      configSource,
    };
  } catch (cause) {
    closeFailedHistoryRead(scope);
    throw cause;
  }
}
