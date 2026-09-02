import { EventEmitter } from 'node:events';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { type AllProjectsScope, openAllProjects } from '@orcaops/project-scope';
import { archiveRoot, artifactsRoot } from '@orcaops/storage';

import { AgentActivityReader, type AgentActivityReaderLike } from './agent-activity.js';
import { DiffStatReader } from './diff-stats.js';
import { EventTailReader } from './event-tail.js';
import type { Thresholds } from './liveness.js';
import { collectFromScope } from './snapshot.js';
import type { WatchSnapshot } from './types.js';

export interface EngineOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  rootOverride?: string;
  thresholds?: Thresholds;
  activityReader?: AgentActivityReaderLike;
}

/**
 * Holds the cross-project scope open across ticks. Each tick incrementally
 * refreshes every archive handle, prepares the hot projection, and re-collects an
 * immutable snapshot, classifies, and emits `snapshot`. A cheap per-tick readdir
 * detects a changed archived-project set and reopens the scope. A per-project
 * refresh failure is swallowed (stale project — keep the last projection) so one
 * bad index never crashes the tick.
 *
 * The engine does NOT own a timer — the render loop drives `tick()` on an
 * interval, and fs.watch pushes drive it too. Emits
 * `snapshot` (WatchSnapshot); it is an EventEmitter, so `.on('snapshot', …)`.
 */
export class SnapshotEngine extends EventEmitter {
  private scope: AllProjectsScope | null = null;
  private archivedDirs = new Set<string>();
  private closed = false;
  private lastSnapshot: WatchSnapshot | null = null;
  private tickTail: Promise<void> = Promise.resolve();
  // Persistent across ticks so unchanged event logs cost zero re-reads.
  private readonly tailReader = new EventTailReader();
  private readonly diffReader = new DiffStatReader();
  private readonly activityReader: AgentActivityReaderLike;

  constructor(private readonly opts: EngineOptions) {
    super();
    this.activityReader = opts.activityReader ?? new AgentActivityReader(opts.env ?? process.env);
  }

  /** The most recent snapshot, so a subscriber attaching AFTER start() (the
   *  ink App) can seed its initial state instead of waiting a full tick. */
  get snapshot(): WatchSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * Directories to fs.watch for push-driven ticks: the archive projects dir
   * (covers every mirrored/archived project) + the current checkout's hot
   * artifacts dir (covers an archive-off repo whose writes never mirror) + the
   * checkout's reviews dir (journal/comment appends from a second process land
   * live in an open TUI). Valid only after start()/openScope().
   */
  getWatchRoots(): string[] {
    const roots = [path.join(archiveRoot(this.opts.env ?? process.env), 'projects')];
    const hot =
      this.scope?.projects.find((p) => p.hot)?.hotStore ?? this.scope?.unidentifiedHot?.hotStore;
    if (hot) {
      roots.push(artifactsRoot(hot.repoRoot, hot.config));
      roots.push(path.join(hot.repoRoot, '.orcaops', 'reviews'));
    }
    return roots;
  }

  /** Open the scope and emit the first snapshot. */
  async start(): Promise<void> {
    await this.openScope();
    await this.tick();
  }

  /** Run one tick. `nowMs` is injectable for deterministic tests. */
  tick(nowMs?: number): Promise<void> {
    const run = this.tickTail.then(() => this.performTick(nowMs));
    // Serialize timer and fs.watch pushes. Keep a rejection handler attached so
    // fire-and-forget callers cannot produce a late unhandled rejection; callers
    // that await `run` still receive the original failure.
    this.tickTail = run.catch(() => undefined);
    return run;
  }

  private async performTick(nowMs?: number): Promise<void> {
    if (this.closed || !this.scope) return;

    const retryHotIdentity = this.scope.issues.some(
      (issue) => issue.kind === 'project_identity_unavailable' && issue.source === 'hot'
    );
    if (retryHotIdentity || (await this.archivedSetChanged())) {
      await this.openScope();
    }
    if (this.closed || !this.scope) return;
    const scope = this.scope;

    for (const handle of scope.projects) {
      try {
        await handle.refresh?.();
      } catch {
        // Stale project (sqlite contention, transient fs error) — keep its last
        // projection rather than crashing the whole tick.
      }
    }
    await scope.prepareHotStoresForRead();
    if (this.closed) return;

    const snapshot: WatchSnapshot = await collectFromScope(scope, {
      env: this.opts.env,
      thresholds: this.opts.thresholds,
      nowMs: nowMs ?? Date.now(),
      tailReader: this.tailReader,
      diffReader: this.diffReader,
      activityReader: this.activityReader,
    });
    if (this.closed) return;
    this.lastSnapshot = snapshot;
    this.emit('snapshot', snapshot);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const scope = this.scope;
    this.scope = null;
    // An active tick may still be using this scope. Close it after the serialized
    // queue drains; queued ticks see `closed` and return without touching it.
    void this.tickTail.then(
      () => scope?.close(),
      () => scope?.close()
    );
  }

  private async openScope(): Promise<void> {
    const previous = this.scope;
    this.scope = null;
    previous?.close();
    const opened = await openAllProjects({
      cwd: this.opts.cwd,
      env: this.opts.env,
      rootOverride: this.opts.rootOverride,
      includeArchiveForHot: true,
      allowUnidentifiedHot: true,
      throwOnHotOpenError: true,
    });
    const archivedDirs = await this.readArchivedDirs();
    if (this.closed) {
      opened.close();
      return;
    }
    this.scope = opened;
    this.archivedDirs = archivedDirs;
  }

  private async readArchivedDirs(): Promise<Set<string>> {
    const projectsDir = path.join(archiveRoot(this.opts.env ?? process.env), 'projects');
    try {
      const entries = await readdir(projectsDir, { withFileTypes: true });
      return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    } catch {
      return new Set();
    }
  }

  private async archivedSetChanged(): Promise<boolean> {
    const now = await this.readArchivedDirs();
    if (now.size !== this.archivedDirs.size) return true;
    for (const id of now) if (!this.archivedDirs.has(id)) return true;
    return false;
  }
}
