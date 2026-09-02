import { scrubAndBound } from '@orcaops/core';
import type { Repo } from '@orcaops/core';
import { repoDisplayName } from '@orcaops/project-scope';
import {
  archiveLocksDir,
  ArchiveMirror,
  archiveProjectDir,
  archiveRoot,
  type Config,
  indexRoot,
  loadRegistry,
  registryPath,
  saveRegistry,
  touchProject,
  writeCachedirTag,
} from '@orcaops/storage';

import { getInvocationEnv } from './invocation-context.js';
import { ensureProjectId, readProjectId } from './project-identity.js';
import { writeTerminalSafeStderr } from '../io/output.js';

/**
 * Archive wiring for `buildContext`. When `archive.enabled`:
 * ensure the project identity exists (mint-on-first-use — a superset of
 * "mint on first capture"; contenders coordinate through a Git common-directory
 * lock), build the write-through mirror, and touch the self-healing registry.
 *
 * The WHOLE path is fail-open: any error disables archiving for this
 * invocation with one stderr line and returns null — archive trouble must
 * never break a command. The disabled path (`archive.enabled: false`)
 * costs nothing: no fs or git access of any kind.
 */
export interface ArchiveContext {
  mirror: ArchiveMirror;
  projectId: string;
  dataRoot: string;
  projectDir: string;
}

export async function buildArchiveContext(
  repoRoot: string,
  config: Config,
  repo: Repo,
  opts: { mintIdentity?: boolean } = {}
): Promise<ArchiveContext | null> {
  if (!config.archive.enabled) return null;
  try {
    const env = getInvocationEnv();
    const dataRoot = archiveRoot(env);
    // Event-writing verbs mint-on-first-use so their events mirror from the
    // first capture; read verbs must stay writers of nothing — with no
    // identity there is nothing mirrored to read, so archive wiring simply
    // stays off for the invocation (the next minting verb heals the mirror).
    let projectId: string;
    if (opts.mintIdentity === false) {
      const existing = await readProjectId(repo);
      if (existing === null) return null;
      projectId = existing;
    } else {
      projectId = (await ensureProjectId(repo)).projectId;
    }
    const projectDir = archiveProjectDir(dataRoot, projectId);
    const idxRoot = indexRoot(env);
    // Mirror lock dirs live under the index root, so classify it as cache the
    // moment archive wiring runs (idempotent; doctor asserts the tag).
    await writeCachedirTag(idxRoot);
    const mirror = new ArchiveMirror({
      projectDir,
      locksDir: archiveLocksDir(idxRoot, projectId),
      redactSecrets: config.archive.redact_secrets,
      // Mirror warnings interpolate raw Error.message from event I/O, so they
      // reach stderr on the same terms as any other error text.
      onWarn: (m) => writeTerminalSafeStderr(`${scrubAndBound(m, 1024)}\n`),
    });
    await touchRegistry(dataRoot, projectId, repoRoot, repo);
    return { mirror, projectId, dataRoot, projectDir };
  } catch (err) {
    writeTerminalSafeStderr(
      `${scrubAndBound(
        `orcaops archive: disabled for this invocation — ${
          err instanceof Error ? err.message : String(err)
        }`,
        1024
      )}\n`
    );
    return null;
  }
}

/**
 * Registry touch. Steady state (path already the freshest hint) is one
 * small JSON read and NO git subprocesses / writes; the remote and
 * root-sha hints are gathered only when this path is new to the registry.
 */
async function touchRegistry(
  dataRoot: string,
  projectId: string,
  repoRoot: string,
  repo: Repo
): Promise<void> {
  const file = registryPath(dataRoot);
  const registry = await loadRegistry(file);
  const prior = registry.projects[projectId];
  const pathIsFresh = prior !== undefined && prior.last_seen_paths[0] === repoRoot;
  // Derive from the git common-dir (the repo), so a worktree stores the repo name
  // rather than its branch-named dir. The `||` short-circuit keeps the steady-state
  // (path-fresh, name already stored) path free of any git subprocess.
  const hints = pathIsFresh
    ? { displayName: prior.display_name || (await repoDisplayName(repo, repoRoot)), path: repoRoot }
    : {
        displayName: await repoDisplayName(repo, repoRoot),
        path: repoRoot,
        remote: await repo.getRemoteUrl(),
        rootCommitShas: await repo.getRootCommitShas(),
      };
  const result = touchProject(registry, projectId, {
    ...hints,
    ts: new Date().toISOString(),
  });
  if (result.changed) await saveRegistry(file, result.registry);
}
