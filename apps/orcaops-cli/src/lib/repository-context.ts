import { access } from 'node:fs/promises';
import path from 'node:path';

import {
  configFromSource,
  Repo,
  resolveConfigSource,
  type ResolvedConfigSource,
} from '@orcaops/core';
import { ProjectIdentityError, readProjectId } from '@orcaops/project-scope';
import { type Config, ConfigValidationError } from '@orcaops/storage';

import { getInvocationCwd, getInvocationEnv } from './invocation-context.js';
import { resolveOrcaopsRoot } from './resolve-root.js';
import { resolveSkillGates, type SkillGates } from './skill-set.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export interface RepositoryContextOptions {
  cwd?: string;
  /** When true (default), require the repository to be initialized. */
  requireInit?: boolean;
  /**
   * Already-resolved root supplied programmatically (highest precedence
   * in `resolveOrcaopsRoot`, skipping discovery). The `--root` flag itself
   * arrives via ALS, not here.
   */
  root?: string;
}

export interface RepositoryContext {
  repoRoot: string;
  repo: Repo;
  config: Config;
  source: ResolvedConfigSource;
}

/**
 * Resolve the repository a command runs against: its root, a validated git
 * worktree, and the loaded configuration. This is the half of the command
 * context that carries no history authority at all, so a command that only
 * reads configuration and writes installation files can stop here instead of
 * opening a store it never uses.
 */
export async function resolveRepositoryContext(
  opts: RepositoryContextOptions = {}
): Promise<RepositoryContext> {
  const cwd = path.resolve(opts.cwd ?? getInvocationCwd());
  // Anchor to the git worktree root (or an explicit --root / ORCAOPS_ROOT
  // override) so a command works from any subdirectory. Throws NOT_A_REPO
  // when cwd is not in a git work tree and no override is set.
  const repoRoot = await resolveOrcaopsRoot({ cwd, root: opts.root });
  const repo = new Repo(repoRoot);

  try {
    await repo.getCurrentBranch();
  } catch {
    try {
      await access(path.join(repoRoot, '.orcaops'));
      await readProjectId(repo);
    } catch (error) {
      if (error instanceof ProjectIdentityError) {
        throw new OrcaopsError(ErrorCodes.INVALID_INPUT, error.message);
      }
    }
    throw new OrcaopsError(
      ErrorCodes.NOT_A_REPO,
      `${repoRoot} is not a git repository (or has no commits yet).`
    );
  }

  // Initialization is a property of the CONFIG, not of `<worktree>/.orcaops`:
  // a personal install lives in the git common dir, so requiring a local
  // directory would report every linked worktree uninitialized, and a
  // leftover data directory would report an uninstalled one as ready.
  let source: ResolvedConfigSource;
  let config: Config;
  try {
    source = await resolveConfigSource(repoRoot);
    config = configFromSource(source);
  } catch (err) {
    // Storage's `ConfigValidationError` carries the offending dotted
    // path. Remap to the public `INVALID_CONFIG` envelope at the CLI
    // boundary — storage doesn't depend on the CLI's error registry.
    if (err instanceof ConfigValidationError) {
      throw new OrcaopsError(ErrorCodes.INVALID_CONFIG, err.message, err.path);
    }
    throw err;
  }
  if (opts.requireInit !== false && source.kind === 'none') {
    throw new OrcaopsError(
      ErrorCodes.UNINITIALIZED,
      `${repoRoot} is not initialized for orcaops. Run \`orcaops init\` first ` +
        `(resolved root: ${repoRoot}; override the root with --root or ORCAOPS_ROOT).`
    );
  }
  return { repoRoot, repo, config, source };
}

export interface InstallCommandContext {
  repoRoot: string;
  repo: Repo;
  config: Config;
  gates: SkillGates;
}

/**
 * The context for a command whose whole subject is installation files —
 * instruction files, install manifests, the install lock. It opens no history
 * store, so it neither validates nor initializes one, and a repository whose
 * history is missing or mid-conversion can still repair its install.
 */
export async function resolveInstallCommandContext(
  opts: RepositoryContextOptions = {}
): Promise<InstallCommandContext> {
  const { repoRoot, repo, config } = await resolveRepositoryContext(opts);
  return { repoRoot, repo, config, gates: resolveSkillGates(getInvocationEnv()) };
}
