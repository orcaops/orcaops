import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { HistoryConversionError } from './errors.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { isUuidV7 } from './legacy/storage/ids/uuidv7.js';
import {
  assertConfigVersionCurrent,
  DEFAULT_CONFIG,
  resolveConfig,
} from './legacy/storage/schema/config.js';
import {
  assertLegacyDirectoryUnchanged,
  inventoryLegacySource,
  legacyDirectoryIdentity,
  legacyFileIdentity,
  type LegacySourceFile,
  type LegacySourceInventory,
  observeLegacySourceFile,
} from './source-files.js';
import { runLegacyGit } from './source-git-process.js';
import {
  enumerateLegacyGitContexts,
  type LegacyGitContext,
  resolveLegacyGitContext,
} from './source-git.js';
import {
  CANONICAL_PROJECT_DATABASE,
  CANONICAL_REPOSITORY_REGISTRATION,
  CANONICAL_WORKTREE_REGISTRATION,
  containsLegacyOmission,
  isOmittedLegacyMember,
  isOmittedLegacyRef,
  type LegacySourceOmission,
  legacySourceOmissions,
  type LegacySourceScope,
} from './source-omissions.js';
import { type LegacyRoot, normalizeLegacyRoot } from './source-paths.js';
import {
  inspectLegacyPresence,
  type LegacyPresenceCheck,
  observeLegacyRegistryMembership,
} from './source-presence.js';

export interface LegacyDiscoveryIssue {
  location: string;
  code: 'SOURCE_UNAVAILABLE' | 'SOURCE_CONFLICT' | 'SOURCE_INTEGRITY';
  reason: string;
}

export interface LegacyDiscoveredSource {
  kind: 'checkout' | 'git-administration' | 'archive-project' | 'catalog';
  root: string;
  relativePath: string;
  state: 'absent' | 'available' | 'unavailable';
  inventory: LegacySourceInventory | null;
  file: LegacySourceFile | null;
}

export interface LegacyCanonicalTargetPresence {
  location: string;
  state: 'absent' | 'present' | 'unavailable';
}

export interface LegacyRepositoryInventory {
  root: LegacyRoot;
  projectId: string | null;
  current: LegacyGitContext;
  worktrees: readonly LegacyGitContext[];
  gitInventoryHash: string;
  gitResourcesHash: string;
  gitResources: readonly { ref: string; oid: string; symbolicTarget: string | null }[];
  presenceChecks: readonly LegacyPresenceCheck[];
  presenceHash: string;
  sources: readonly LegacyDiscoveredSource[];
  layouts: readonly LegacyResourceLayout[];
  omitted: readonly LegacySourceOmission[];
  issues: readonly LegacyDiscoveryIssue[];
  inventoryComplete: boolean;
  target: {
    database: LegacyCanonicalTargetPresence;
    catalog: LegacyCanonicalTargetPresence;
    repository: LegacyCanonicalTargetPresence;
    worktree: LegacyCanonicalTargetPresence;
  } | null;
  manifestHash: string;
}

export interface LegacyResourceLayout {
  kind: 'checkout' | 'archive';
  root: string;
  artifacts: string;
  usage: string;
  sqlite: string | null;
  seed: string | null;
  seedState: string | null;
  sourcePlan: string | null;
  configuration: { root: string; relativePath: string; sha256: string } | null;
}

function normalizeSupportedConfig(raw: unknown): unknown {
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    (raw as Record<string, unknown>).schema_version !== 4
  )
    return raw;
  const config = raw as Record<string, unknown>;
  if (config.watch !== undefined) {
    if (config.watch === null || typeof config.watch !== 'object' || Array.isArray(config.watch))
      return raw;
    const watch = config.watch as Record<string, unknown>;
    if (Object.keys(watch).some((key) => key !== 'theme')) return raw;
    const theme = watch.theme;
    if (theme !== undefined && (typeof theme !== 'string' || theme.length === 0)) return raw;
  }
  let normalizedLlm = config.llm;
  if (config.llm !== undefined) {
    if (config.llm === null || typeof config.llm !== 'object' || Array.isArray(config.llm))
      return raw;
    const llm = config.llm as Record<string, unknown>;
    for (const key of ['default_session_max_cost_usd', 'default_timeout_ms'] as const) {
      const value = llm[key];
      if (
        value !== undefined &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value <= 0 ||
          (key === 'default_timeout_ms' && !Number.isInteger(value)))
      )
        return raw;
    }
    if (llm.json_mode !== undefined && !['auto', 'on', 'off'].includes(llm.json_mode as string))
      return raw;
    if (llm.session !== undefined) {
      if (llm.session === null || typeof llm.session !== 'object' || Array.isArray(llm.session))
        return raw;
      const session = llm.session as Record<string, unknown>;
      if (
        Object.keys(session).some(
          (key) => !['persist', 'max_age_minutes', 'invalidate_on_model_change'].includes(key)
        ) ||
        (session.persist !== undefined && typeof session.persist !== 'boolean') ||
        (session.invalidate_on_model_change !== undefined &&
          typeof session.invalidate_on_model_change !== 'boolean') ||
        (session.max_age_minutes !== undefined &&
          (typeof session.max_age_minutes !== 'number' ||
            !Number.isInteger(session.max_age_minutes) ||
            session.max_age_minutes <= 0))
      )
        return raw;
    }
    const {
      default_session_max_cost_usd: _sessionCost,
      default_timeout_ms: _timeout,
      json_mode: _jsonMode,
      session: _session,
      ...remainingLlm
    } = llm;
    normalizedLlm = remainingLlm;
  }
  const { watch: _watch, ...remainingConfig } = config;
  return { ...remainingConfig, schema_version: 5, llm: normalizedLlm };
}

async function inspectMember(root: string, relativePath: string) {
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || relativePath.includes('\\'))
    throw new HistoryConversionError('SOURCE_UNAVAILABLE', 'Invalid source path', relativePath);
  for (let n = 0; n <= parts.length; n++) {
    let info;
    try {
      info = await lstat(path.join(root, ...parts.slice(0, n)), { bigint: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw cause;
    }
    if (info.isSymbolicLink() || (n < parts.length && !info.isDirectory()))
      throw new HistoryConversionError(
        'SOURCE_UNAVAILABLE',
        'Unsupported source parent',
        relativePath
      );
    if (n === parts.length) return info;
  }
  return null;
}

async function gitResources(cwd: string, sourceEnv: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const { stdout } = await runLegacyGit(
    cwd,
    [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(symref)',
      'refs/orcaops/',
      'refs/notes/orcaops',
    ],
    { env: sourceEnv, signal }
  );
  return stdout
    .split('\n')
    .filter((line) => line && !isOmittedLegacyRef(line.split('\0')[0]!))
    .map((line) => {
      const [ref, oid, target, ...extra] = line.split('\0');
      if (
        !ref ||
        !oid ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) ||
        target === undefined ||
        extra.length
      )
        throw new HistoryConversionError(
          'SOURCE_INTEGRITY',
          'Malformed retained Git resource inventory'
        );
      return { ref, oid, symbolicTarget: target || null };
    });
}

export async function discoverLegacyRepository(input: {
  cwd: string;
  root?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  additionalCheckouts?: readonly string[];
  additionalSourcePaths?: readonly string[];
  expectedProjectId?: string;
  signal?: AbortSignal;
}): Promise<LegacyRepositoryInventory> {
  const { cwd, root: selectedRoot, home, expectedProjectId, signal } = input;
  const env = { ...(input.env ?? process.env) };
  const additionalCheckouts = [...(input.additionalCheckouts ?? [])];
  const additionalSourcePaths = [...(input.additionalSourcePaths ?? [])];
  if (expectedProjectId !== undefined && !isUuidV7(expectedProjectId))
    throw new HistoryConversionError('SOURCE_CONFLICT', 'Selected project identity is invalid');
  signal?.throwIfAborted();
  const root = await normalizeLegacyRoot({ root: selectedRoot, env, home, cwd });
  const current = await resolveLegacyGitContext({ cwd, env, signal });
  const inventory = await enumerateLegacyGitContexts(current, { env, signal });
  const resources = await gitResources(current.worktreeRoot, env, signal);
  const worktrees = [...inventory.contexts];
  const sources: LegacyDiscoveredSource[] = [];
  const layouts: LegacyResourceLayout[] = [];
  const omitted: LegacySourceOmission[] = [
    {
      location: 'refs/orcaops/review/',
      family: 'task-review-refs',
      state: 'intentionally-not-inspected',
    },
  ];
  const issues: LegacyDiscoveryIssue[] = inventory.unresolved.map((entry) => ({
    location: entry.worktreeRoot,
    code: 'SOURCE_UNAVAILABLE',
    reason: 'Git worktree could not be inspected',
  }));
  const issue = (location: string, code: LegacyDiscoveryIssue['code'], reason: string) =>
    issues.push({ location, code, reason });
  const configurations: { root: string; relativePath: string; file: LegacySourceFile | null }[] =
    [];
  for (const location of additionalSourcePaths)
    issue(
      location,
      'SOURCE_CONFLICT',
      'Additional non-checkout sources require an explicit supported source association; this profile does not infer one from a path'
    );
  for (const checkout of additionalCheckouts) {
    signal?.throwIfAborted();
    try {
      const context = await resolveLegacyGitContext({ cwd: checkout, env, signal });
      if (context.commonDir !== current.commonDir) {
        issue(checkout, 'SOURCE_CONFLICT', 'Explicit checkout belongs to another Git repository');
        continue;
      }
      if (!worktrees.some((entry) => entry.gitDir === context.gitDir)) worktrees.push(context);
    } catch {
      signal?.throwIfAborted();
      issue(checkout, 'SOURCE_UNAVAILABLE', 'Explicit checkout could not be inspected');
    }
  }
  worktrees.sort((a, b) => (a.gitDir < b.gitDir ? -1 : a.gitDir > b.gitDir ? 1 : 0));
  const projectId = current.projectId;
  const presence = await inspectLegacyPresence({
    context: current,
    root,
    projectId,
    env,
    signal,
    worktreeRoots: worktrees.map((context) => context.worktreeRoot),
  });
  if (presence.git_inventory_hash !== inventory.hash)
    throw new HistoryConversionError(
      'SOURCE_CHANGED',
      'Git source inventory changed during presence checks'
    );
  for (const entry of presence.unresolved)
    issue(
      `${entry.context_id}:${entry.relative_location}`,
      'SOURCE_UNAVAILABLE',
      'Expected legacy marker cannot be classified'
    );
  if (expectedProjectId !== undefined && expectedProjectId !== projectId)
    issue(
      'project',
      'SOURCE_CONFLICT',
      'Selected project is not established by repository Git identity'
    );
  for (const context of worktrees) {
    if (context.projectId !== projectId)
      issue(context.worktreeRoot, 'SOURCE_CONFLICT', 'Worktree identity is inconsistent');
    // A registered repository still conflicts as a conversion source: its markers are reported
    // by name in `target` so an operator can see them, and a conversion interrupted after a
    // publisher resumes by completing the missing publications rather than by re-reading
    // sources whose observed tree the markers have already changed.
    if (context.canonicalMarkers.length)
      issue(
        context.gitDir,
        'SOURCE_CONFLICT',
        'Canonical metadata is present; inspect its expected database authority separately'
      );
  }
  const inspect = async (
    kind: LegacyDiscoveredSource['kind'],
    base: string,
    relative: string,
    scope?: LegacySourceScope
  ) => {
    signal?.throwIfAborted();
    if (sources.some((source) => source.root === base && source.relativePath === relative)) return;
    try {
      const stat = await inspectMember(base, relative);
      let source: LegacyDiscoveredSource;
      if (!stat)
        source = {
          kind,
          root: base,
          relativePath: relative,
          state: 'absent',
          inventory: null,
          file: null,
        };
      else if (stat.isDirectory()) {
        const observed = await inventoryLegacySource({
          root: path.join(base, relative),
          scope,
          signal,
        });
        const after = await inspectMember(base, relative);
        if (
          !after ||
          after.ino !== stat.ino ||
          after.dev !== stat.dev ||
          canonicalJson(legacyDirectoryIdentity(after, path.join(base, relative), scope)) !==
            canonicalJson(legacyDirectoryIdentity(stat, path.join(base, relative), scope))
        )
          throw new HistoryConversionError(
            'SOURCE_CHANGED',
            'Source directory changed during discovery',
            relative
          );
        source = {
          kind,
          root: base,
          relativePath: relative,
          state: observed.complete ? 'available' : 'unavailable',
          inventory: observed,
          file: null,
        };
        for (const entry of observed.issues)
          issue(path.join(base, relative, entry.relativePath), entry.code, entry.reason);
      } else if (stat.isFile()) {
        source = {
          kind,
          root: base,
          relativePath: relative,
          state: 'available',
          inventory: null,
          file: (await observeLegacySourceFile({ root: base, relativePath: relative, signal }))
            .file,
        };
      } else
        throw new HistoryConversionError(
          'SOURCE_UNAVAILABLE',
          'Source is not a regular file or directory',
          relative
        );
      sources.push(source);
    } catch (cause) {
      if (
        signal?.aborted ||
        (cause instanceof HistoryConversionError && cause.code === 'SOURCE_CHANGED')
      )
        throw cause;
      sources.push({
        kind,
        root: base,
        relativePath: relative,
        state: 'unavailable',
        inventory: null,
        file: null,
      });
      issue(path.join(base, relative), 'SOURCE_UNAVAILABLE', 'Selected source cannot be inspected');
    }
  };
  for (const context of worktrees) {
    const checkout = context.worktreeRoot;
    const candidates = ['.orcaops'];
    const scope = { kind: 'checkout' as const, root: checkout };
    omitted.push(...legacySourceOmissions(scope));
    let configRoot = checkout;
    let configPath = '.orcaops/config.json';
    let effective = DEFAULT_CONFIG;
    let configuration: LegacyResourceLayout['configuration'] = null;
    let supportedConfiguration = true;
    try {
      const local = await inspectMember(checkout, configPath);
      if (!local) {
        configurations.push({ root: checkout, relativePath: configPath, file: null });
        configRoot = context.commonDir;
        configPath = 'orcaops/config.json';
      }
      if (local || (await inspectMember(configRoot, configPath))) {
        const observed = await observeLegacySourceFile({
          root: configRoot,
          relativePath: configPath,
          includeBytes: true,
          scope: configRoot === checkout ? scope : null,
          signal,
        });
        configurations.push({ root: configRoot, relativePath: configPath, file: observed.file });
        const raw = normalizeSupportedConfig(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(observed.bytes!))
        );
        assertConfigVersionCurrent(raw);
        const config = resolveConfig(raw);
        if ((config.install.scope === 'personal') !== (configRoot === context.commonDir))
          throw new HistoryConversionError(
            'SOURCE_INTEGRITY',
            'Legacy configuration scope disagrees with its location',
            configPath
          );
        effective = config;
        configuration = {
          root: configRoot,
          relativePath: configPath,
          sha256: observed.file.sha256,
        };
        for (const configured of [
          config.artifacts.path,
          config.cache.path,
          `${config.cache.path}-wal`,
          `${config.cache.path}-shm`,
          `${config.cache.path}-journal`,
          path.posix.join(path.posix.dirname(config.cache.path), 'seed'),
        ])
          if (configured !== '.orcaops' && !configured.startsWith('.orcaops/'))
            candidates.push(configured);
      } else configurations.push({ root: configRoot, relativePath: configPath, file: null });
    } catch (cause) {
      if (
        signal?.aborted ||
        (cause instanceof HistoryConversionError && cause.code === 'SOURCE_CHANGED')
      )
        throw cause;
      issue(
        path.join(configRoot, configPath),
        'SOURCE_INTEGRITY',
        'Legacy configuration does not match the frozen supported profile'
      );
      supportedConfiguration = false;
    }
    if (supportedConfiguration) {
      const included = [
        effective.artifacts.path,
        effective.cache.path,
        `${effective.cache.path}-wal`,
        `${effective.cache.path}-shm`,
        `${effective.cache.path}-journal`,
        path.posix.join(path.posix.dirname(effective.cache.path), 'seed'),
        '.orcaops/cache/source-plan',
      ];
      const overlap = included.find(
        (relative) =>
          isOmittedLegacyMember(path.resolve(checkout, relative), scope) ||
          containsLegacyOmission(path.resolve(checkout, relative), scope)
      );
      if (overlap) {
        issue(
          path.join(checkout, overlap),
          'SOURCE_CONFLICT',
          'Configured in-scope history overlaps an intentionally omitted Task Review location; resolve shared source ownership explicitly'
        );
        continue;
      }
      layouts.push({
        kind: 'checkout',
        root: checkout,
        artifacts: effective.artifacts.path,
        usage: '.orcaops/usage',
        sqlite: effective.cache.path,
        seed: path.posix.join(path.posix.dirname(effective.cache.path), 'seed'),
        seedState: null,
        sourcePlan: '.orcaops/cache/source-plan',
        configuration,
      });
    }
    for (const relative of [...new Set(candidates)].sort())
      await inspect('checkout', checkout, relative, scope);
    await inspect('git-administration', context.gitDir, 'orcaops', {
      kind: 'git-administration',
      root: path.join(context.gitDir, 'orcaops'),
    });
  }
  await inspect('git-administration', current.commonDir, 'orcaops', {
    kind: 'git-administration',
    root: path.join(current.commonDir, 'orcaops'),
  });
  await inspect('catalog', root.resolvedRoot, 'projects.json');
  const membership = presence.registryMembership;
  const archivedProjectExpected = Boolean(projectId && membership?.projectIds.includes(projectId));
  for (const observation of membership?.observations ?? [])
    if (observation.projectId !== projectId && observation.matchesCheckout)
      issue(
        'projects.json',
        'SOURCE_CONFLICT',
        'Catalog path hint conflicts with the repository project identity'
      );
  if (projectId) {
    const scope = {
      kind: 'archive' as const,
      root: path.join(root.resolvedRoot, 'projects', projectId),
    };
    omitted.push(...legacySourceOmissions(scope));
    await inspect('archive-project', root.resolvedRoot, `projects/${projectId}`, scope);
    if (
      archivedProjectExpected &&
      sources.find((source) => source.kind === 'archive-project')?.state === 'absent'
    )
      issue(
        `projects/${projectId}`,
        'SOURCE_UNAVAILABLE',
        'Catalog-established archive project is missing'
      );
    if (await inspectMember(root.resolvedRoot, `projects/${projectId}/history-format.json`))
      issue(
        'history-format.json',
        'SOURCE_CONFLICT',
        'An existing canonical format requires its recovery path'
      );
    layouts.push({
      kind: 'archive',
      root: path.join(root.resolvedRoot, 'projects', projectId),
      artifacts: 'artifacts',
      usage: 'usage',
      sqlite: null,
      seed: null,
      seedState: 'seed-state.json',
      sourcePlan: null,
      configuration: null,
    });
  }
  // The canonical target is observed by name only, outside the source manifest,
  // so a retry after target creation still sees the same source proof.
  const targetPresence = async () => {
    if (!projectId) return null;
    const presence = async (relative: string): Promise<LegacyCanonicalTargetPresence> => {
      const location = path.join(root.resolvedRoot, relative);
      try {
        const stat = await inspectMember(root.resolvedRoot, relative);
        return {
          location,
          state: stat === null ? 'absent' : stat.isFile() ? 'present' : 'unavailable',
        };
      } catch {
        return { location, state: 'unavailable' };
      }
    };
    const marker = async (
      root: string,
      relative: string
    ): Promise<LegacyCanonicalTargetPresence> => {
      const location = path.join(root, relative);
      try {
        const stat = await inspectMember(root, relative);
        return {
          location,
          state: stat === null ? 'absent' : stat.isFile() ? 'present' : 'unavailable',
        };
      } catch {
        return { location, state: 'unavailable' };
      }
    };
    return {
      database: await presence(`projects/${projectId}/${CANONICAL_PROJECT_DATABASE}`),
      catalog: await presence(`projects/catalog/${projectId}.json`),
      repository: await marker(current.commonDir, `orcaops/${CANONICAL_REPOSITORY_REGISTRATION}`),
      worktree: await marker(current.gitDir, `orcaops/${CANONICAL_WORKTREE_REGISTRATION}`),
    };
  };
  const target = await targetPresence();
  for (const config of configurations) {
    const now = await inspectMember(config.root, config.relativePath);
    if (
      canonicalJson(now ? legacyFileIdentity(now) : null) !==
      canonicalJson(config.file?.identity ?? null)
    )
      throw new HistoryConversionError(
        'SOURCE_CHANGED',
        'Source configuration changed during discovery'
      );
  }
  for (const source of sources) {
    if (source.state === 'unavailable') continue;
    const now = await inspectMember(source.root, source.relativePath);
    if (source.state === 'absent') {
      if (now)
        throw new HistoryConversionError('SOURCE_CHANGED', 'A source appeared during discovery');
      continue;
    }
    const expected = source.file?.identity ?? source.inventory!.directories[0]!.identity;
    if (
      !now ||
      canonicalJson(
        source.file
          ? legacyFileIdentity(now)
          : legacyDirectoryIdentity(
              now,
              path.join(source.root, source.relativePath),
              source.inventory!.scope
            )
      ) !== canonicalJson(expected)
    )
      throw new HistoryConversionError('SOURCE_CHANGED', 'A source changed during discovery');
    if (source.inventory) {
      for (const directory of source.inventory.directories)
        await assertLegacyDirectoryUnchanged(
          source.inventory.root,
          directory,
          source.inventory.scope
        );
      for (const entry of source.inventory.files) {
        const relative = [source.relativePath, entry.relativePath].filter(Boolean).join('/');
        const member = await inspectMember(source.root, relative);
        if (!member || canonicalJson(legacyFileIdentity(member)) !== canonicalJson(entry.identity))
          throw new HistoryConversionError(
            'SOURCE_CHANGED',
            'An inventoried member changed during discovery',
            relative
          );
      }
    }
  }
  if (
    membership &&
    canonicalJson(
      await observeLegacyRegistryMembership(
        root,
        worktrees.map((context) => context.worktreeRoot),
        signal
      )
    ) !== canonicalJson(membership)
  )
    throw new HistoryConversionError(
      'SOURCE_CHANGED',
      'Legacy archive membership hints changed during discovery'
    );
  const after = await enumerateLegacyGitContexts(
    await resolveLegacyGitContext({ cwd, env, signal }),
    { env, signal }
  );
  if (
    after.hash !== inventory.hash ||
    canonicalJson(after.contexts) !== canonicalJson(inventory.contexts) ||
    canonicalJson(await gitResources(current.worktreeRoot, env, signal)) !==
      canonicalJson(resources)
  )
    throw new HistoryConversionError(
      'SOURCE_CHANGED',
      'Git source inventory changed during discovery'
    );
  if (canonicalJson(await targetPresence()) !== canonicalJson(target))
    throw new HistoryConversionError(
      'SOURCE_CHANGED',
      'Canonical target presence changed during discovery'
    );
  const result = {
    root,
    projectId,
    current,
    worktrees,
    gitInventoryHash: inventory.hash,
    gitResourcesHash: createHash('sha256').update(canonicalJson(resources)).digest('hex'),
    gitResources: resources,
    presenceChecks: presence.checked,
    presenceHash: presence.proof_hash,
    sources,
    layouts,
    omitted,
    issues,
    inventoryComplete: issues.length === 0,
  };
  return {
    ...result,
    target,
    manifestHash: createHash('sha256').update(canonicalJson(result)).digest('hex'),
  };
}
