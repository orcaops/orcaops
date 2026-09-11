import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { HistoryConversionError } from './errors.js';
import { observeLegacySourceFile } from './source-files.js';
import { runLegacyGit } from './source-git-process.js';
import {
  enumerateLegacyGitContexts,
  type LegacyGitContext,
  type LegacyGitInventory,
  type LegacyGitOptions,
  readLegacyGitText,
} from './source-git.js';
import { isOmittedLegacyRef } from './source-omissions.js';
import { inspectLegacyPath, type LegacyRoot } from './source-paths.js';
import { LEGACY_CHECKOUT_LOCATIONS } from './source-presence-locations.js';

export interface LegacyPresenceCheck {
  context_id: string;
  relative_location: string;
  state: 'absent' | 'present' | 'inaccessible' | 'unclassified';
  reason?: string;
}

export interface LegacyPresence {
  checked: LegacyPresenceCheck[];
  unresolved: LegacyPresenceCheck[];
  git_inventory_hash: string;
  proof_hash: string;
  inventory: LegacyGitInventory;
  registryMembership: LegacyRegistryMembership | null;
}

export interface LegacyRegistry {
  schema_version: 1;
  projects: Record<string, { last_seen_paths?: string[]; [key: string]: unknown }>;
}

export async function readLegacyRegistry(root: LegacyRoot): Promise<LegacyRegistry | null> {
  if (!(await inspectLegacyPath(root.resolvedRoot, 'projects.json'))) return null;
  const observed = await observeLegacySourceFile({
    root: root.resolvedRoot,
    relativePath: 'projects.json',
    includeBytes: true,
  });
  const raw: unknown = JSON.parse(observed.bytes!.toString('utf8'));
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('schema_version' in raw) ||
    raw.schema_version !== 1 ||
    !('projects' in raw) ||
    typeof raw.projects !== 'object' ||
    raw.projects === null ||
    Array.isArray(raw.projects)
  )
    throw new HistoryConversionError('SOURCE_INTEGRITY', 'Selected project catalog is malformed');
  for (const [projectId, value] of Object.entries(raw.projects)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(projectId))
      throw new HistoryConversionError(
        'SOURCE_INTEGRITY',
        'Selected project catalog contains an invalid project identity'
      );
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      ('last_seen_paths' in value &&
        (!Array.isArray(value.last_seen_paths) ||
          value.last_seen_paths.some((item: unknown) => typeof item !== 'string')))
    )
      throw new HistoryConversionError(
        'SOURCE_INTEGRITY',
        'Selected project catalog contains malformed path metadata'
      );
  }
  return raw as LegacyRegistry;
}

export interface LegacyRegistryMembership {
  projectIds: string[];
  observations: {
    projectId: string;
    hint: string;
    resolvedPath: string | null;
    matchesCheckout: boolean;
  }[];
}
export async function observeLegacyRegistryMembership(
  root: LegacyRoot,
  worktreeRoots: readonly string[],
  signal?: AbortSignal
): Promise<LegacyRegistryMembership> {
  const registry = await readLegacyRegistry(root);
  const roots = new Set(worktreeRoots);
  const projectIds = Object.keys(registry?.projects ?? {}).sort();
  const observations: LegacyRegistryMembership['observations'] = [];
  for (const projectId of projectIds) {
    for (const hint of registry!.projects[projectId]!.last_seen_paths ?? []) {
      signal?.throwIfAborted();
      const resolvedPath = await realpath(hint).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null;
        throw new HistoryConversionError(
          'SOURCE_UNAVAILABLE',
          'Legacy archive membership hint cannot be inspected',
          hint
        );
      });
      signal?.throwIfAborted();
      observations.push({
        projectId,
        hint,
        resolvedPath,
        matchesCheckout:
          roots.has(path.resolve(hint)) || (resolvedPath !== null && roots.has(resolvedPath)),
      });
    }
  }
  return { projectIds, observations };
}

export async function inspectLegacyPresence(
  input: LegacyGitOptions & {
    context: LegacyGitContext;
    root: LegacyRoot;
    projectId?: string | null;
    worktreeRoots?: readonly string[];
  }
): Promise<LegacyPresence> {
  const inventory = await enumerateLegacyGitContexts(input.context, input);
  const checked: LegacyPresenceCheck[] = [];
  const unresolved: LegacyPresenceCheck[] = inventory.unresolved.map((entry) => ({
    context_id: entry.worktreeRoot,
    relative_location: '.git',
    state: 'unclassified',
    reason: entry.reason,
  }));
  const add = (check: LegacyPresenceCheck) => {
    checked.push(check);
    if (check.state === 'inaccessible' || check.state === 'unclassified') unresolved.push(check);
  };
  const probe = async (
    root: string,
    relative: string,
    contextId: string,
    expected: 'file' | 'directory' | 'any' = 'directory'
  ) => {
    try {
      const info = await inspectLegacyPath(root, relative);
      const wrongType =
        info &&
        ((expected === 'file' && !info.isFile()) ||
          (expected === 'directory' && !info.isDirectory()));
      add({
        context_id: contextId,
        relative_location: relative,
        state: wrongType ? 'unclassified' : info ? 'present' : 'absent',
        ...(wrongType ? { reason: 'Supported marker has an unexpected type' } : {}),
      });
    } catch (cause) {
      input.signal?.throwIfAborted();
      add({
        context_id: contextId,
        relative_location: relative,
        state: 'inaccessible',
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  for (const context of inventory.contexts) {
    for (const relative of LEGACY_CHECKOUT_LOCATIONS)
      await probe(
        context.worktreeRoot,
        relative,
        context.gitDir,
        relative === '.orcaops' ? 'any' : 'file'
      );
    await probe(context.gitDir, 'orcaops', context.gitDir);
  }
  if (!inventory.contexts.some((context) => context.gitDir === input.context.commonDir))
    await probe(input.context.commonDir, 'orcaops', input.context.commonDir);
  for (const [location, args] of [
    ['git-config:orcaops', ['config', '--local', '--get-regexp', '^orcaops\\.']],
    [
      'git-refs:orcaops',
      ['for-each-ref', '--format=%(refname)', 'refs/orcaops/', 'refs/notes/orcaops'],
    ],
  ] as const) {
    try {
      const result = await runLegacyGit(input.context.worktreeRoot, args, {
        ...input,
        allowedExitCodes: [1],
      });
      add({
        context_id: input.context.commonDir,
        relative_location: location,
        state: result.stdout
          .split('\n')
          .some((line) => line && (location !== 'git-refs:orcaops' || !isOmittedLegacyRef(line)))
          ? 'present'
          : 'absent',
      });
    } catch (cause) {
      input.signal?.throwIfAborted();
      add({
        context_id: input.context.commonDir,
        relative_location: location,
        state: 'unclassified',
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  try {
    const info = await inspectLegacyPath(input.context.commonDir, 'info/exclude');
    const text = info ? await readLegacyGitText(input.context.commonDir, 'info/exclude') : '';
    add({
      context_id: input.context.commonDir,
      relative_location: 'info/exclude:orcaops',
      state: /orcaops/i.test(text) ? 'present' : 'absent',
    });
  } catch (cause) {
    input.signal?.throwIfAborted();
    add({
      context_id: input.context.commonDir,
      relative_location: 'info/exclude:orcaops',
      state: 'unclassified',
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
  let registryMembership: LegacyRegistryMembership | null = null;
  try {
    registryMembership = await observeLegacyRegistryMembership(
      input.root,
      input.worktreeRoots ?? inventory.contexts.map((context) => context.worktreeRoot),
      input.signal
    );
    const present =
      Boolean(input.projectId && registryMembership.projectIds.includes(input.projectId)) ||
      registryMembership.observations.some((observation) => observation.matchesCheckout);
    add({
      context_id: input.root.rootKey,
      relative_location: 'projects.json:membership',
      state: present ? 'present' : 'absent',
    });
  } catch (cause) {
    input.signal?.throwIfAborted();
    add({
      context_id: input.root.rootKey,
      relative_location: 'projects.json:membership',
      state: 'unclassified',
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (input.projectId) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.projectId)
    )
      throw new HistoryConversionError('SOURCE_CONFLICT', 'Bootstrap project identity is invalid');
    await probe(
      input.root.resolvedRoot,
      path.join('projects', input.projectId),
      input.root.rootKey
    );
  }
  return {
    checked,
    unresolved,
    git_inventory_hash: inventory.hash,
    proof_hash: createHash('sha256')
      .update(JSON.stringify([inventory.hash, checked, unresolved, registryMembership]))
      .digest('hex'),
    inventory,
    registryMembership,
  };
}
