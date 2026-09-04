import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Repo } from '@orcaops/core';
import { PROJECT_ID_CONFIG_KEY } from '@orcaops/project-scope';
import {
  archiveArtifactPaths,
  archiveLocksDir,
  ArchiveMirror,
  archiveProjectDir,
  artifactPathsFor,
  ArtifactStore,
  type CaptureAgentId,
  getDefaultConfig,
  indexRoot,
  isUuidV7,
  type UsageSnapshotRow,
  uuidv7,
} from '@orcaops/storage';
import { createTempRepo, writeProjectConfig } from '@orcaops/test-harness';

/**
 * Watch snapshot test fixtures. Real lifecycles: an ArtifactStore with a
 * write-through ArchiveMirror (wired through `ArtifactStoreOptions.archive`),
 * so the archive tree contains exactly what production mirroring produces. Usage
 * is injected straight into the store via `insertUsageSnapshot` (the same row a
 * ledger replay projects). Everything is parameterized off a temp data root, so
 * no ambient ~/.orcaops is ever touched.
 */

export interface SeedArtifactOpts {
  artifactId: string;
  task?: string;
  branch?: string;
  agent?: CaptureAgentId;
  /** Total plan steps. */
  stepCount?: number;
  /** Steps a closed checkpoint claims (completed). Requires stepCount >= this. */
  closedSteps?: number;
  /** Leave an open checkpoint declaring the step after the closed ones. */
  openCp?: boolean;
  /** Uncertainty recorded on the closed checkpoint. */
  uncertainty?: string[];
  /** Plan started_at (ISO) — drives the 24h activity window. */
  startedAt?: string;
  /** Sessions to attribute to this artifact (tokens go in cumulative_input). */
  sessions?: Array<{ agent?: string; session_id: string; tokens: number }>;
}

export interface FixtureProject {
  repoPath: string;
  projectId: string;
  projectDir: string;
  store: ArtifactStore;
  seed(opts: SeedArtifactOpts): Promise<void>;
  /** Close the artifact's single open checkpoint (appends a new archive event). */
  closeOpenCp(artifactId: string, opts?: { uncertainty?: string[] }): Promise<void>;
  hotEventsPath(artifactId: string): string;
  archiveEventsPath(artifactId: string): string;
}

export interface ArchiveFixture {
  base: string;
  dataRoot: string;
  env: NodeJS.ProcessEnv;
  /** An archived-only project (its repo's events mirror into the shared tree). */
  archiveProject(projectId: string): Promise<FixtureProject>;
  /**
   * A hot repo with a minted project id, mirroring into its own archive dir.
   * A canonical UUIDv7 `key` is used verbatim (tests may assert on it);
   * any other key maps to one minted UUIDv7 per fixture (read it back from
   * `FixtureProject.projectId`) — hot discovery rejects non-UUIDv7 ids, so a
   * friendly key must never reach git config.
   */
  hotProject(key: string): Promise<FixtureProject>;
  /** A sibling repo sharing an existing project's id + archive dir. */
  sibling(key: string): Promise<FixtureProject>;
  /** A repo with `.orcaops` but NO minted id (allowUnidentifiedHot / CTA path). */
  unidentifiedRepo(): Promise<FixtureProject>;
  cleanup(): Promise<void>;
}

export async function makeArchiveFixture(): Promise<ArchiveFixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'orcaops-watch-fx-'));
  const dataRoot = path.join(base, 'archive');
  // Self-contained: index root resolves under <dataRoot>/index-cache (no XDG override).
  const env: NodeJS.ProcessEnv = { ORCAOPS_DATA_DIR: dataRoot };
  const stores: ArtifactStore[] = [];
  const repos: Array<{ cleanup: () => Promise<void> }> = [];
  const mintedIds = new Map<string, string>();
  const mintedId = (key: string): string => {
    if (isUuidV7(key)) return key;
    const prior = mintedIds.get(key);
    if (prior) return prior;
    const id = uuidv7();
    mintedIds.set(key, id);
    return id;
  };

  async function makeProject(
    projectId: string,
    projectDir: string,
    mint: boolean,
    withMirror: boolean
  ): Promise<FixtureProject> {
    const repo = await createTempRepo({ initialBranch: 'main' });
    // Governed by a project config: data alone never counts as an install.
    await writeProjectConfig(repo.path);
    repos.push(repo);
    if (mint) await new Repo(repo.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, projectId);
    const mirror = withMirror
      ? new ArchiveMirror({
          projectDir,
          locksDir: archiveLocksDir(indexRoot(env), projectId),
          redactSecrets: false,
        })
      : undefined;
    const store = new ArtifactStore({
      repoRoot: repo.path,
      config: getDefaultConfig(),
      archive: mirror ?? null,
    });
    stores.push(store);
    return {
      repoPath: repo.path,
      projectId,
      projectDir,
      store,
      seed: (opts) => seedArtifact(store, opts),
      closeOpenCp: async (artifactId, opts) => {
        const open = store.store.getOpenCheckpoints(artifactId);
        if (open.length === 0) throw new Error(`no open checkpoint on ${artifactId}`);
        const cp = open[0];
        await store.writeCheckpointClosed(
          {
            artifact_id: artifactId,
            n: cp.n,
            summary: `closed cp ${cp.n} of ${artifactId}`,
            files_changed: ['src/y.ts'],
            decisions: [],
            uncertainty: opts?.uncertainty ?? [],
            done_criteria: [],
            verification: [{ command: 'watch fixture checkpoint', exit_code: 0 }],
            completed_step_ids: cp.declared_step_ids,
            head_sha: 'beefcafe',
          },
          { idempotencyKey: `close-${artifactId}-${cp.n}` }
        );
      },
      hotEventsPath: (artifactId) =>
        artifactPathsFor(repo.path, getDefaultConfig(), artifactId).eventsNdjson,
      archiveEventsPath: (artifactId) => archiveArtifactPaths(projectDir, artifactId).eventsNdjson,
    };
  }

  return {
    base,
    dataRoot,
    env,
    archiveProject: (projectId) =>
      makeProject(projectId, archiveProjectDir(dataRoot, projectId), false, true),
    hotProject: (key) => {
      const id = mintedId(key);
      return makeProject(id, archiveProjectDir(dataRoot, id), true, true);
    },
    sibling: (key) => {
      const id = mintedId(key);
      return makeProject(id, archiveProjectDir(dataRoot, id), false, true);
    },
    unidentifiedRepo: () => makeProject('unidentified', path.join(base, 'unused'), false, false),
    cleanup: async () => {
      for (const s of stores) s.close();
      for (const r of repos) await r.cleanup();
      await rm(base, { recursive: true, force: true });
    },
  };
}

export async function seedArtifact(store: ArtifactStore, opts: SeedArtifactOpts): Promise<void> {
  const stepCount = opts.stepCount ?? 1;
  const closedSteps = opts.closedSteps ?? 0;
  const stepIds = Array.from({ length: stepCount }, () => uuidv7());

  await store.writePlan(
    {
      schema_version: 4,
      artifact_id: opts.artifactId,
      branch: opts.branch ?? 'feat/x',
      base_sha: 'abc123',
      agent: opts.agent ?? 'claude-code',
      agent_session_id: null,
      task: opts.task ?? `task ${opts.artifactId}`,
      label: `label ${opts.artifactId}`.slice(0, 60),
      plan_steps: stepIds.map((id, i) => ({
        step_id: id,
        text: `step ${i + 1}`,
        label: `s${i + 1}`,
        acceptance_criteria: [],
      })),
      touched_scope: [],
      non_goals: [],
      started_at: opts.startedAt ?? '2026-07-02T12:00:00.000Z',
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    },
    { idempotencyKey: `plan-${opts.artifactId}` }
  );

  if (closedSteps > 0) {
    const claimed = stepIds.slice(0, closedSteps);
    await store.writeCheckpointOpened(
      { artifact_id: opts.artifactId, declared_step_ids: claimed },
      { idempotencyKey: `open1-${opts.artifactId}`, headSha: 'cafef00d' }
    );
    await store.writeCheckpointClosed(
      {
        artifact_id: opts.artifactId,
        n: 1,
        summary: `finished ${claimed.length} step(s) of ${opts.artifactId}`,
        files_changed: ['src/x.ts'],
        decisions: [],
        uncertainty: opts.uncertainty ?? [],
        done_criteria: [],
        verification: [{ command: 'watch fixture setup', exit_code: 0 }],
        completed_step_ids: claimed,
        head_sha: 'cafef00d',
      },
      { idempotencyKey: `close1-${opts.artifactId}` }
    );
  }

  if (opts.openCp) {
    const declared = [stepIds[closedSteps] ?? stepIds[0]];
    await store.writeCheckpointOpened(
      { artifact_id: opts.artifactId, declared_step_ids: declared },
      { idempotencyKey: `open2-${opts.artifactId}`, headSha: 'deadbeef' }
    );
  }

  for (const s of opts.sessions ?? []) {
    store.store.insertUsageSnapshot(
      usageRow(opts.artifactId, s.session_id, s.agent ?? 'claude-code', s.tokens)
    );
  }
}

function usageRow(
  artifactId: string,
  sessionId: string,
  agent: string,
  tokens: number
): UsageSnapshotRow {
  return {
    snapshot_id: uuidv7(),
    idempotency_key: `usage-${artifactId}-${sessionId}`,
    artifact_id: artifactId,
    source_plan_ref_id: null,
    agent,
    session_id: sessionId,
    lifecycle_event: 'plan',
    checkpoint_n: null,
    cumulative_input_tokens: tokens,
    cumulative_output_tokens: 0,
    cumulative_cache_creation_input_tokens: 0,
    cumulative_cache_read_input_tokens: 0,
    delta_input_tokens: null,
    delta_output_tokens: null,
    delta_cache_creation_input_tokens: null,
    delta_cache_read_input_tokens: null,
    baseline_kind: 'first_observation',
    model_breakdown: '[]',
    dimensions: '{}',
    record_count: 1,
    as_of: '2026-07-02T12:00:00.000Z',
    ts: '2026-07-02T12:00:00.000Z',
  };
}
