import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  type GitAdministrativeContext,
  HistoryError,
  type HistoryRoot,
  inspectHistoryPath,
  readHistoryMetadata,
} from '@orcaops/storage/history/authority';

import { readGitAdministrativeText, runHistoryGit } from './git-context.js';
import { BOOTSTRAP_CHECKOUT_LOCATIONS } from './presence-locations.js';

export { BOOTSTRAP_CHECKOUT_LOCATIONS } from './presence-locations.js';

export interface BootstrapPresenceCheck {
  context_id: string;
  relative_location: string;
  state: 'absent' | 'present' | 'inaccessible' | 'unclassified';
  reason?: string;
  /**
   * What a present check proves. The conversion gate exists to protect legacy HISTORY, so
   * only a `history` source makes a repository unfresh; `configuration` evidence — the
   * orcaops config, the exclude block, the git-config identity, the generated skill and
   * command files, an empty registry entry, manifest or locks directory — is recorded for
   * the evidence trail and never forces the conversion path on its own.
   */
  kind: 'history' | 'configuration';
}

interface PresenceInventory {
  contexts: GitAdministrativeContext[];
  unresolved: Array<{ worktreeRoot: string; reason: string }>;
  hash: string;
}

export interface BootstrapPresence<T extends PresenceInventory = PresenceInventory> {
  checked: BootstrapPresenceCheck[];
  unresolved: BootstrapPresenceCheck[];
  git_inventory_hash: string;
  proof_hash: string;
  fresh: boolean;
  /** No legacy HISTORY source is present; configuration-only evidence does not count. */
  history_fresh: boolean;
  inventory: T;
}

export interface HistoryCatalog {
  schema_version: 1;
  projects: Record<string, { last_seen_paths?: string[]; [key: string]: unknown }>;
}

export async function readSelectedHistoryCatalog(
  root: HistoryRoot
): Promise<HistoryCatalog | null> {
  const raw = await readHistoryMetadata(
    root.resolvedRoot,
    path.join(root.resolvedRoot, 'projects.json')
  );
  if (raw === null) return null;
  if (
    typeof raw !== 'object' ||
    !('schema_version' in raw) ||
    raw.schema_version !== 1 ||
    !('projects' in raw) ||
    typeof raw.projects !== 'object' ||
    raw.projects === null ||
    Array.isArray(raw.projects)
  )
    throw new HistoryError('HISTORY_INTEGRITY_REQUIRED', 'Selected project catalog is malformed');
  for (const [projectId, value] of Object.entries(raw.projects)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(projectId))
      throw new HistoryError(
        'HISTORY_INTEGRITY_REQUIRED',
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
      throw new HistoryError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Selected project catalog contains malformed path metadata'
      );
  }
  return raw as HistoryCatalog;
}

export async function inspectBootstrapInventory<T extends PresenceInventory>(
  input: {
    context: GitAdministrativeContext;
    root: HistoryRoot;
    projectId?: string | null;
  },
  inventory: T
): Promise<BootstrapPresence<T>> {
  const checked: BootstrapPresenceCheck[] = [];
  const unresolved: BootstrapPresenceCheck[] = inventory.unresolved.map((entry) => ({
    context_id: entry.worktreeRoot,
    relative_location: '.git',
    state: 'unclassified',
    reason: entry.reason,
    kind: 'history',
  }));
  const add = (check: BootstrapPresenceCheck) => {
    checked.push(check);
    if (check.state === 'inaccessible' || check.state === 'unclassified') unresolved.push(check);
  };
  const probe = async (
    root: string,
    relative: string,
    contextId: string,
    expected: 'file' | 'directory' | 'any' = 'directory',
    kind: BootstrapPresenceCheck['kind'] = 'configuration'
  ) => {
    try {
      const info = await inspectHistoryPath(root, path.join(root, relative));
      const wrongType =
        info &&
        ((expected === 'file' && !info.isFile()) ||
          (expected === 'directory' && !info.isDirectory()));
      add({
        context_id: contextId,
        relative_location: relative,
        state: wrongType ? 'unclassified' : info ? 'present' : 'absent',
        ...(wrongType ? { reason: 'Supported marker has an unexpected type' } : {}),
        kind,
      });
    } catch (cause) {
      add({
        context_id: contextId,
        relative_location: relative,
        state: 'inaccessible',
        reason: cause instanceof Error ? cause.message : String(cause),
        kind,
      });
    }
  };
  for (const context of inventory.contexts) {
    // The generated skills and commands are install output; `.orcaops` is the legacy
    // artifact store and is the only checkout location that is history.
    for (const relative of BOOTSTRAP_CHECKOUT_LOCATIONS)
      await probe(
        context.worktreeRoot,
        relative,
        context.gitDir,
        relative === '.orcaops' ? 'any' : 'file',
        relative === '.orcaops' ? 'history' : 'configuration'
      );
    // `.git/orcaops` holds the configuration and the install lock directory.
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
      const result = await runHistoryGit(input.context.worktreeRoot, args, [1]);
      add({
        context_id: input.context.commonDir,
        relative_location: location,
        state: result.stdout.length > 0 ? 'present' : 'absent',
        // Retained refs ARE history; a git-config project identity is configuration.
        kind: location === 'git-refs:orcaops' ? 'history' : 'configuration',
      });
    } catch (cause) {
      add({
        context_id: input.context.commonDir,
        relative_location: location,
        state: 'unclassified',
        reason: cause instanceof Error ? cause.message : String(cause),
        kind: location === 'git-refs:orcaops' ? 'history' : 'configuration',
      });
    }
  }
  try {
    const file = path.join(input.context.commonDir, 'info', 'exclude');
    const info = await inspectHistoryPath(input.context.commonDir, file);
    const text = info ? await readGitAdministrativeText(file) : '';
    add({
      context_id: input.context.commonDir,
      relative_location: 'info/exclude:orcaops',
      state: /orcaops/i.test(text) ? 'present' : 'absent',
      kind: 'configuration',
    });
  } catch (cause) {
    add({
      context_id: input.context.commonDir,
      relative_location: 'info/exclude:orcaops',
      state: 'unclassified',
      reason: cause instanceof Error ? cause.message : String(cause),
      kind: 'configuration',
    });
  }
  try {
    const catalog = await readSelectedHistoryCatalog(input.root);
    const paths = new Set(inventory.contexts.map((context) => context.worktreeRoot));
    let present = Boolean(input.projectId && catalog?.projects[input.projectId]);
    for (const project of Object.values(catalog?.projects ?? {})) {
      for (const hint of project.last_seen_paths ?? []) {
        if (paths.has(path.resolve(hint))) present = true;
        else {
          const resolved = await realpath(hint).catch(() => null);
          if (resolved && paths.has(resolved)) present = true;
        }
      }
    }
    // A registry entry alone is bookkeeping, not history: mirrored CONTENT is reached
    // through the project directory below and through the scope's own missing-history
    // refusal, so membership on its own never forces the conversion path.
    add({
      context_id: input.root.rootKey,
      relative_location: 'projects.json:membership',
      state: present ? 'present' : 'absent',
      kind: 'configuration',
    });
  } catch (cause) {
    add({
      context_id: input.root.rootKey,
      relative_location: 'projects.json:membership',
      state: 'unclassified',
      reason: cause instanceof Error ? cause.message : String(cause),
      kind: 'history',
    });
  }
  if (input.projectId) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.projectId)
    )
      throw new HistoryError('IDENTITY_CONFLICT', 'Bootstrap project identity is invalid');
    await probe(
      input.root.resolvedRoot,
      path.join('projects', input.projectId),
      input.root.rootKey,
      'directory',
      'history'
    );
  }
  const fresh = unresolved.length === 0 && checked.every((check) => check.state === 'absent');
  // The conversion gate protects history, so it reads this instead: configuration evidence
  // is recorded but never forces the conversion path, while anything unresolved is still
  // treated as possible history. `fresh` keeps its original meaning for the activation and
  // bootstrap paths, which ask whether a repository is untouched, not whether it has history.
  const historyFresh =
    unresolved.length === 0 &&
    checked.every((check) => check.state === 'absent' || check.kind === 'configuration');
  return {
    checked,
    unresolved,
    git_inventory_hash: inventory.hash,
    proof_hash: createHash('sha256')
      .update(JSON.stringify([inventory.hash, checked, unresolved]))
      .digest('hex'),
    fresh,
    history_fresh: historyFresh,
    inventory,
  };
}
