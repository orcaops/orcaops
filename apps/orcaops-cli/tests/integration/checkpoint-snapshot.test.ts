import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { baselineRefName } from '@orcaops/core';
import { CheckpointSnapshotBoundarySchema } from '@orcaops/storage';
import { createRepoTemplate, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { clearCloudLogin, commitFile, seedCloudLogin } from '../support/test-helpers.js';

/**
 * CLI snapshot + fingerprint capture wiring.
 *
 * End-to-end coverage that the three callback wirings in
 * `apps/orcaops-cli/src/commands/capture/checkpoint.ts` correctly
 * thread through core's `captureCheckpointSnapshot`,
 * `diffSnapshotTrees` and `buildDiffFingerprintManifest`,
 * producing real `open_snapshot` / `close_snapshot` boundaries and
 * `diff_fingerprint_summary` / `diff_fingerprint_manifest` event
 * payloads on disk.
 *
 * Readback: plain `readFile` on `.orcaops/artifacts/<id>/checkpoint-<n>.json`
 * (projection) and `events.ndjson` (full event payload — the manifest
 * lives here, not on the projection). For small fixtures the manifest
 * stays inline; these tests don't exercise the 8 KB sidecar
 * spill (covered by the rebuilder tests).
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface OkEnvelope {
  ok: true;
  [k: string]: unknown;
}

function parseOk<T = OkEnvelope>(r: CliResult): T {
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(true);
  return parsed as T;
}

interface CapturedPlan {
  artifact_id: string;
  step_ids: string[];
}

interface CheckpointSnapshotBoundaryRaw {
  snapshot_ref: string | null;
  tree_sha: string | null;
  snapshot_commit_sha: string | null;
  snapshot_error_reason: string | null;
}

interface DiffFingerprintSummaryRaw {
  status: 'captured' | 'empty' | 'truncated' | 'skipped';
  hunk_count: number;
  captured_hunk_count: number;
  truncated: boolean;
  fingerprint_algorithm: string | null;
  manifest_hash: string | null;
  manifest_hash_algorithm: string | null;
  error_reason: string | null;
}

interface ClosedCheckpointProjection {
  status: 'closed';
  n: number;
  open_snapshot: CheckpointSnapshotBoundaryRaw;
  close_snapshot: CheckpointSnapshotBoundaryRaw;
  diff_fingerprint_summary: DiffFingerprintSummaryRaw;
}

interface AbandonedCheckpointProjection {
  status: 'abandoned';
  n: number;
  reason: string;
  open_snapshot: CheckpointSnapshotBoundaryRaw;
  abandon_snapshot: CheckpointSnapshotBoundaryRaw;
  // Deliberately NO diff_fingerprint_summary: abandon events don't carry it
  // (per `AbandonedCheckpointV4Schema`).
  diff_fingerprint_summary?: never;
}

interface OpenCheckpointProjection {
  status: 'open';
  n: number;
  open_snapshot: CheckpointSnapshotBoundaryRaw;
}

interface CheckpointClosedEventPayload {
  artifact_id: string;
  n: number;
  diff_fingerprint_summary: DiffFingerprintSummaryRaw;
  diff_fingerprint_manifest?: {
    schema_version: number;
    hunks: unknown[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

async function readCheckpointProjection<T = unknown>(
  repoPath: string,
  artifactId: string,
  n: number
): Promise<T> {
  const p = path.join(repoPath, '.orcaops', 'artifacts', artifactId, `checkpoint-${n}.json`);
  return JSON.parse(await readFile(p, 'utf8')) as T;
}

interface EventRecord {
  type: string;
  event_id: string;
  payload?: unknown;
  sidecar_sha256?: string;
  sidecar_size?: number;
  [k: string]: unknown;
}

async function readEventLog(repoPath: string, artifactId: string): Promise<EventRecord[]> {
  const p = path.join(repoPath, '.orcaops', 'artifacts', artifactId, 'events.ndjson');
  const text = await readFile(p, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EventRecord);
}

async function loadEventPayload<T>(
  repoPath: string,
  artifactId: string,
  rec: EventRecord
): Promise<T> {
  if (rec.payload !== undefined) return rec.payload as T;
  if (rec.sidecar_sha256) {
    const sidecarPath = path.join(
      repoPath,
      '.orcaops',
      'artifacts',
      artifactId,
      'sidecars',
      `${rec.event_id}.json`
    );
    return JSON.parse(await readFile(sidecarPath, 'utf8')) as T;
  }
  throw new Error(`event ${rec.event_id} has neither inline payload nor sidecar`);
}

async function readLatestCheckpointClosedPayload(
  repoPath: string,
  artifactId: string,
  n: number
): Promise<CheckpointClosedEventPayload> {
  const events = await readEventLog(repoPath, artifactId);
  const matches = events.filter(
    (e) => e.type === 'checkpoint_closed' && (e.payload as { n?: number } | undefined)?.n === n
  );
  if (matches.length === 0) {
    // Sidecar-spilled events may carry the n in the sidecar payload, not
    // the inline record — load each sidecar payload to find the match.
    const allClosed = events.filter((e) => e.type === 'checkpoint_closed');
    for (const e of allClosed) {
      const payload = await loadEventPayload<CheckpointClosedEventPayload>(repoPath, artifactId, e);
      if (payload.n === n) return payload;
    }
    throw new Error(`no checkpoint_closed event found for n=${n}`);
  }
  // Use the LATEST match (in case of multiple — shouldn't happen for a
  // single closed cp, but defensive against future event-log shape changes).
  const latest = matches[matches.length - 1];
  return loadEventPayload<CheckpointClosedEventPayload>(repoPath, artifactId, latest);
}

function countCheckpointClosedEvents(events: EventRecord[]): number {
  return events.filter((e) => e.type === 'checkpoint_closed').length;
}

interface WarningEntry {
  code: string;
  message: string;
}

function findWarning(warnings: WarningEntry[] | undefined, code: string): WarningEntry | undefined {
  return warnings?.find((w) => w.code === code);
}

/**
 * Synthesize an unmerged index entry (stages 1/2/3, no stage 0) for
 * `filePath` via `git update-index --index-info` — the canonical way to
 * forge a merge-conflict index without running a real merge — and write
 * conflict-marker content to the worktree so the snapshot tree carries
 * realistic bytes.
 */
function forgeConflict(repoPath: string, filePath: string): void {
  const stageLine = (content: string, stage: number): string => {
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repoPath,
      input: content,
      encoding: 'utf8',
    }).trim();
    return `100644 ${sha} ${stage}\t${filePath}`;
  };
  const indexInfo = `${[
    stageLine(`base of ${filePath}\n`, 1),
    stageLine(`ours of ${filePath}\n`, 2),
    stageLine(`theirs of ${filePath}\n`, 3),
  ].join('\n')}\n`;
  execFileSync('git', ['update-index', '--index-info'], { cwd: repoPath, input: indexInfo });
  const markers = `<<<<<<< HEAD\nours of ${filePath}\n=======\ntheirs of ${filePath}\n>>>>>>> theirs\n`;
  // Sync write via git's own plumbing-free path is unnecessary — the tests
  // that need worktree bytes write them here.
  execFileSync('sh', ['-c', `cat > "$1"`, 'sh', filePath], { cwd: repoPath, input: markers });
}

/** Resolve a forged conflict: write resolved content and stage it. */
function resolveConflict(repoPath: string, filePath: string, resolved: string): void {
  execFileSync('sh', ['-c', `cat > "$1"`, 'sh', filePath], { cwd: repoPath, input: resolved });
  execFileSync('git', ['add', '--', filePath], { cwd: repoPath });
}

describe('checkpoint snapshot + fingerprint capture', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  // `init` is identical for every test here and costs ~450ms; run it once and
  // give each test a ~20ms copy of the result.
  const template = createRepoTemplate(
    async (repoPath) => {
      await makeAgent({ cwd: repoPath, env: { ORCAOPS_DISABLE_DRAIN: '1' } }).runRaw([
        'init',
        '--scope',
        'project',
        '--json',
        '--no-llm',
      ]);
    },
    { initialBranch: 'main' }
  );

  beforeEach(async () => {
    repo = await template.checkout();
    // Drain disabled so capture runs with no real cloud I/O (the temp repo also has no
    // git remote, which short-circuits eager push). No login seed: snapshot capture is
    // auth-independent; the auth-state tests below seed creds per-test.
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
  });

  afterEach(async () => {
    clearCloudLogin();
    await repo.cleanup();
  });

  afterAll(async () => {
    await template.destroy();
  });

  async function capturePlan(stepTexts: string[]): Promise<CapturedPlan> {
    const plan_steps = stepTexts.map((text, idx) => ({ text, label: `s${idx + 1}` }));
    const r = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'snapshot + fingerprint capture test',
          label: 'snapshot-capture-test',
          plan_steps,
          touched_scope: [],
        })
      ),
    ]);
    const ok = parseOk<
      OkEnvelope & {
        artifact_id: string;
        plan_steps: Array<{ step_id: string; idx: number; label: string; text: string }>;
      }
    >(r);
    return { artifact_id: ok.artifact_id, step_ids: ok.plan_steps.map((s) => s.step_id) };
  }

  async function openCp(payload: Record<string, unknown>): Promise<CliResult> {
    return agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(JSON.stringify({ idempotency_key: `open-${randomUUID()}`, ...payload })),
    ]);
  }

  async function closeCp(
    payload: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<CliResult> {
    return agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: idempotencyKey ?? `close-${randomUUID()}`,
          verification: [{ command: 'test fixture', exit_code: 0 }],
          ...payload,
        })
      ),
    ]);
  }

  async function abandonCp(payload: Record<string, unknown>): Promise<CliResult> {
    return agent.runRaw([
      'capture',
      'checkpoint',
      'abandon',
      '--input',
      inputFile(JSON.stringify({ idempotency_key: `abandon-${randomUUID()}`, ...payload })),
    ]);
  }

  it('open → modify → close: manifest produced with expected hunks', async () => {
    const plan = await capturePlan(['step a']);
    const o1 = parseOk<OkEnvelope & { n: number }>(
      await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
    );
    expect(o1.n).toBe(1);

    // Modify a file AND commit so the close snapshot's tree diverges from
    // the open snapshot's tree. (Capture includes uncommitted changes too,
    // but staging-then-committing keeps the fixture deterministic across
    // git versions and gives us a clean diff for the manifest.)
    await commitFile(
      repo.path,
      'src/foo.ts',
      'export const x = 1;\nexport const y = 2;\n',
      'add foo'
    );

    parseOk(
      await closeCp({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'cp1 added foo',
        files_changed: ['src/foo.ts'],
        completed_step_ids: [plan.step_ids[0]],
      })
    );

    const proj = await readCheckpointProjection<ClosedCheckpointProjection>(
      repo.path,
      plan.artifact_id,
      1
    );
    expect(proj.status).toBe('closed');
    expect(proj.open_snapshot.tree_sha).not.toBeNull();
    expect(proj.close_snapshot.tree_sha).not.toBeNull();
    expect(proj.open_snapshot.tree_sha).not.toEqual(proj.close_snapshot.tree_sha);

    expect(proj.diff_fingerprint_summary.status).toBe('captured');
    expect(proj.diff_fingerprint_summary.hunk_count).toBeGreaterThan(0);
    expect(proj.diff_fingerprint_summary.captured_hunk_count).toEqual(
      proj.diff_fingerprint_summary.hunk_count
    );
    expect(proj.diff_fingerprint_summary.error_reason).toBeNull();
    // base64url-nopad 256-bit hash: 43 chars from [A-Za-z0-9_-].
    expect(proj.diff_fingerprint_summary.manifest_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const payload = await readLatestCheckpointClosedPayload(repo.path, plan.artifact_id, 1);
    expect(payload.diff_fingerprint_manifest).toBeDefined();
    expect(payload.diff_fingerprint_manifest!.hunks.length).toEqual(
      proj.diff_fingerprint_summary.hunk_count
    );
  });

  it('open → modify → close in a repo that gitignores .orcaops/tmp/: boundaries still captured', async () => {
    // Regression guard: a snapshot temp index inside the worktree (e.g.
    // `<repo>/.orcaops/tmp/snap-<uuid>.index`) forces `git add -A` to carry an
    // `:(exclude).orcaops/tmp/**` pathspec — which git refuses outright once
    // that subtree is gitignored ("The following paths are ignored by one of
    // your .gitignore files", exit 1). Capture fails open, so the CLI still
    // exits 0 and the projection still lands: the ONLY visible symptom is null
    // tree SHAs and a skipped fingerprint. Every other test in this file runs
    // against `createTempRepo`, which writes no `.gitignore` at all — the one
    // configuration in which the failure cannot reproduce.
    //
    // Committed BEFORE `capturePlan` (which runs `orcaops init`) so init's own
    // managed lines are appended to this file rather than replacing it — the
    // same layering a real repo has. `diff_fingerprint.enabled` defaults to
    // true, so nothing else needs wiring.
    await commitFile(repo.path, '.gitignore', '.orcaops/tmp/\n', 'gitignore orcaops tmp');

    const plan = await capturePlan(['step a']);
    const o1 = parseOk<OkEnvelope & { n: number }>(
      await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
    );
    expect(o1.n).toBe(1);

    await commitFile(
      repo.path,
      'src/foo.ts',
      'export const x = 1;\nexport const y = 2;\n',
      'add foo'
    );

    parseOk(
      await closeCp({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'cp1 added foo',
        files_changed: ['src/foo.ts'],
        completed_step_ids: [plan.step_ids[0]],
      })
    );

    const proj = await readCheckpointProjection<ClosedCheckpointProjection>(
      repo.path,
      plan.artifact_id,
      1
    );
    expect(proj.status).toBe('closed');

    // Both boundaries captured. The failure mode this guards against is
    // null boundaries carrying snapshot_error_reason 'unknown'.
    expect(proj.open_snapshot.tree_sha).not.toBeNull();
    expect(proj.close_snapshot.tree_sha).not.toBeNull();
    expect(proj.open_snapshot.tree_sha).not.toEqual(proj.close_snapshot.tree_sha);
    expect(proj.open_snapshot.snapshot_error_reason).toBeNull();
    expect(proj.close_snapshot.snapshot_error_reason).toBeNull();
    expect(proj.open_snapshot.snapshot_ref).toBe(`refs/orcaops/snap/${plan.artifact_id}/1/open`);

    // And the fingerprint the boundaries feed still lands.
    expect(proj.diff_fingerprint_summary.status).toBe('captured');
    expect(proj.diff_fingerprint_summary.hunk_count).toBeGreaterThan(0);
    expect(proj.diff_fingerprint_summary.error_reason).toBeNull();

    const payload = await readLatestCheckpointClosedPayload(repo.path, plan.artifact_id, 1);
    expect(payload.diff_fingerprint_manifest).toBeDefined();
    expect(payload.diff_fingerprint_manifest!.hunks.length).toEqual(
      proj.diff_fingerprint_summary.hunk_count
    );

    // The gitignore really is in force — a control against the fixture
    // silently degrading into the no-gitignore configuration every other
    // test already covers.
    const ignored = execFileSync('git', ['check-ignore', '-q', '.orcaops/tmp/probe.index'], {
      cwd: repo.path,
      encoding: 'utf8',
    });
    expect(ignored).toBe('');
  });

  it('open → close with no work: status=empty, manifest body present with hunks=[]', async () => {
    const plan = await capturePlan(['step a']);
    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));
    parseOk(
      await closeCp({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'cp1 no work',
        files_changed: [],
        completed_step_ids: [plan.step_ids[0]],
      })
    );

    const proj = await readCheckpointProjection<ClosedCheckpointProjection>(
      repo.path,
      plan.artifact_id,
      1
    );
    expect(proj.diff_fingerprint_summary.status).toBe('empty');
    expect(proj.diff_fingerprint_summary.hunk_count).toBe(0);
    expect(proj.diff_fingerprint_summary.error_reason).toBeNull();
    // A real hash IS computed even for an empty manifest (canonical-JSON
    // of the manifest with hunks: [] → 256-bit BLAKE3 → 43-char b64url).
    expect(proj.diff_fingerprint_summary.manifest_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const payload = await readLatestCheckpointClosedPayload(repo.path, plan.artifact_id, 1);
    // A REAL manifest object is present in the event payload (defends
    // against a regression that records manifest_hash on the
    // summary but drops the manifest body).
    expect(payload.diff_fingerprint_manifest).toBeDefined();
    expect(payload.diff_fingerprint_manifest).not.toBeNull();
    expect(payload.diff_fingerprint_manifest!.hunks).toEqual([]);
  });

  it('replay of committed close: callback NOT re-invoked', async () => {
    const plan = await capturePlan(['step a']);
    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));
    await commitFile(repo.path, 'src/foo.ts', 'export const x = 1;\n', 'add foo');

    // First close.
    const closeKey = `close-${randomUUID()}`;
    const closePayload = {
      artifact_id: plan.artifact_id,
      n: 1,
      summary: 'cp1',
      files_changed: ['src/foo.ts'],
      completed_step_ids: [plan.step_ids[0]],
    };
    parseOk(await closeCp(closePayload, closeKey));

    // Snapshot pre-replay state: close-ref commit target, projection JSON
    // contents, event-log checkpoint_closed count.
    const closeRefName = `refs/orcaops/snap/${plan.artifact_id}/1/close`;
    const commitBefore = execFileSync('git', ['rev-parse', closeRefName], {
      cwd: repo.path,
      encoding: 'utf8',
    }).trim();
    const projectionBefore = await readFile(
      path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id, 'checkpoint-1.json'),
      'utf8'
    );
    const eventsBefore = await readEventLog(repo.path, plan.artifact_id);
    const closedCountBefore = countCheckpointClosedEvents(eventsBefore);

    // Second close call with the same idempotency_key + same payload.
    const r2 = await closeCp(closePayload, closeKey);
    const replay = parseOk<OkEnvelope & { idempotency_status: string; code: string }>(r2);
    expect(replay.idempotency_status).toBe('replay');
    expect(replay.code).toBe('IDEMPOTENT_REPLAY');

    // Conclusive: no new close commit was minted. If the callback had
    // re-fired, captureCheckpointSnapshot would have produced a fresh
    // commit pointing at the same tree SHA (worktree didn't change), so
    // the commit-sha check is the load-bearing assertion — the
    // manifest_hash check below alone wouldn't catch it (close_tree_sha
    // is unchanged, so manifest_hash is unchanged either way).
    const commitAfter = execFileSync('git', ['rev-parse', closeRefName], {
      cwd: repo.path,
      encoding: 'utf8',
    }).trim();
    expect(commitAfter).toBe(commitBefore);

    // Event count unchanged — no new checkpoint_closed event appended.
    const eventsAfter = await readEventLog(repo.path, plan.artifact_id);
    expect(countCheckpointClosedEvents(eventsAfter)).toBe(closedCountBefore);

    // Defense-in-depth: projection JSON unchanged byte-for-byte.
    const projectionAfter = await readFile(
      path.join(repo.path, '.orcaops', 'artifacts', plan.artifact_id, 'checkpoint-1.json'),
      'utf8'
    );
    expect(projectionAfter).toBe(projectionBefore);
  });

  it('open → abandon mid-work: abandon_snapshot captured, no fingerprint manifest', async () => {
    const plan = await capturePlan(['step a']);
    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));

    // Introduce mid-work change so the abandon snapshot's tree diverges
    // from the open snapshot's tree (proves the abandon callback fires
    // and captures the current worktree, not a frozen open-time copy).
    await commitFile(repo.path, 'src/wip.ts', 'export const inProgress = true;\n', 'wip');

    parseOk(await abandonCp({ artifact_id: plan.artifact_id, n: 1, reason: 'rescope' }));

    const proj = await readCheckpointProjection<AbandonedCheckpointProjection>(
      repo.path,
      plan.artifact_id,
      1
    );
    expect(proj.status).toBe('abandoned');
    expect(proj.reason).toBe('rescope');

    // Abandon snapshot was captured and pinned.
    expect(proj.abandon_snapshot.tree_sha).not.toBeNull();
    expect(proj.abandon_snapshot.snapshot_commit_sha).not.toBeNull();
    expect(proj.abandon_snapshot.snapshot_error_reason).toBeNull();
    expect(proj.abandon_snapshot.snapshot_ref).toBe(
      `refs/orcaops/snap/${plan.artifact_id}/1/abandon`
    );

    // Mid-work change makes the abandon tree differ from the open tree.
    expect(proj.abandon_snapshot.tree_sha).not.toEqual(proj.open_snapshot.tree_sha);

    // Confirm the pinned ref actually exists in git.
    const pinnedCommit = execFileSync('git', ['rev-parse', proj.abandon_snapshot.snapshot_ref!], {
      cwd: repo.path,
      encoding: 'utf8',
    }).trim();
    expect(pinnedCommit).toBe(proj.abandon_snapshot.snapshot_commit_sha);

    // Projection carries NO fingerprint summary for abandoned cps in v1
    // (`AbandonedCheckpointV4Schema` has open_snapshot + abandon_snapshot
    // only — no manifest, no summary).
    expect(proj.diff_fingerprint_summary).toBeUndefined();

    // Event-log abandon payload likewise carries no fingerprint fields.
    const events = await readEventLog(repo.path, plan.artifact_id);
    const abandonRec = events.find(
      (e) => e.type === 'checkpoint_abandoned' && (e.payload as { n?: number } | undefined)?.n === 1
    );
    expect(abandonRec).toBeDefined();
    const abandonPayload = (await loadEventPayload<Record<string, unknown>>(
      repo.path,
      plan.artifact_id,
      abandonRec!
    )) as Record<string, unknown>;
    expect(abandonPayload.abandon_snapshot).toBeDefined();
    expect(abandonPayload.diff_fingerprint_summary).toBeUndefined();
    expect(abandonPayload.diff_fingerprint_manifest).toBeUndefined();
  });

  it('concurrent open cps: distinct snapshot refs, identical tree SHAs (no worktree change)', async () => {
    const plan = await capturePlan(['step a', 'step b']);
    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));
    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[1]] }));

    const proj1 = await readCheckpointProjection<OpenCheckpointProjection>(
      repo.path,
      plan.artifact_id,
      1
    );
    const proj2 = await readCheckpointProjection<OpenCheckpointProjection>(
      repo.path,
      plan.artifact_id,
      2
    );

    // No worktree change between opens → same tree SHA.
    expect(proj1.open_snapshot.tree_sha).not.toBeNull();
    expect(proj2.open_snapshot.tree_sha).not.toBeNull();
    expect(proj1.open_snapshot.tree_sha).toEqual(proj2.open_snapshot.tree_sha);

    // Refs are per-(artifact, n, phase) and therefore distinct.
    expect(proj1.open_snapshot.snapshot_ref).toBe(`refs/orcaops/snap/${plan.artifact_id}/1/open`);
    expect(proj2.open_snapshot.snapshot_ref).toBe(`refs/orcaops/snap/${plan.artifact_id}/2/open`);
    expect(proj1.open_snapshot.snapshot_ref).not.toEqual(proj2.open_snapshot.snapshot_ref);

    // Both refs pinned in git's ref store.
    const refsOut = execFileSync(
      'git',
      ['for-each-ref', '--format=%(refname)', `refs/orcaops/snap/${plan.artifact_id}/`],
      { cwd: repo.path, encoding: 'utf8' }
    );
    const refs = refsOut.split('\n').filter((l) => l.length > 0);
    expect(refs).toContain(`refs/orcaops/snap/${plan.artifact_id}/1/open`);
    expect(refs).toContain(`refs/orcaops/snap/${plan.artifact_id}/2/open`);
  });

  it('unmerged index at open → capture proceeds: real boundary + degraded warning', async () => {
    const plan = await capturePlan(['step a']);

    forgeConflict(repo.path, 'conflict.txt');
    // Sanity: confirm the probe sees the staged entries.
    const lsu = execFileSync('git', ['ls-files', '-u'], { cwd: repo.path, encoding: 'utf8' });
    expect(lsu.length).toBeGreaterThan(0);

    const o = parseOk<OkEnvelope & { status: string; n: number; warnings?: WarningEntry[] }>(
      await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
    );
    expect(o.status).toBe('open');
    expect(o.n).toBe(1);
    const degraded = findWarning(o.warnings, 'unmerged-paths-degraded');
    expect(degraded).toBeDefined();
    expect(degraded?.message).toContain('conflict.txt');
    expect(degraded?.message).toContain('PARTIAL');
    expect(findWarning(o.warnings, 'snapshot-capture-failed')).toBeUndefined();

    // The boundary is a plain success — populated shas, null error.
    const proj = await readCheckpointProjection<OpenCheckpointProjection>(
      repo.path,
      plan.artifact_id,
      1
    );
    expect(proj.open_snapshot.snapshot_error_reason).toBeNull();
    expect(proj.open_snapshot.tree_sha).not.toBeNull();
    expect(proj.open_snapshot.snapshot_ref).toBe(`refs/orcaops/snap/${plan.artifact_id}/1/open`);
    expect(proj.open_snapshot.snapshot_commit_sha).not.toBeNull();

    // The real index is byte-for-byte untouched.
    const lsuAfter = execFileSync('git', ['ls-files', '-u'], { cwd: repo.path, encoding: 'utf8' });
    expect(lsuAfter).toBe(lsu);
  });

  it('conflicted open + clean close → PARTIAL attribution: unrelated hunks kept, conflicted excluded, derive reproduces', async () => {
    const plan = await capturePlan(['step a']);

    forgeConflict(repo.path, 'conflict.txt');
    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));

    // Resolve the conflict inside the window and do unrelated work.
    resolveConflict(repo.path, 'conflict.txt', 'resolved content\n');
    await writeFile(path.join(repo.path, 'other.ts'), 'export const other = 1;\n', 'utf8');

    const c = parseOk<OkEnvelope & { warnings?: WarningEntry[] }>(
      await closeCp({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'work under a resolved conflict',
        files_changed: ['other.ts'],
        completed_step_ids: [plan.step_ids[0]],
      })
    );
    const warn = findWarning(c.warnings, 'unmerged-paths-degraded');
    expect(warn).toBeDefined();
    expect(warn?.message).toContain('conflict.txt');
    expect(warn?.message).toContain('PARTIAL');

    // The fingerprint is real — NOT missing_open_tree_sha — and the
    // degraded union (unmerged at OPEN, resolved before close) persisted.
    const proj = await readCheckpointProjection<
      ClosedCheckpointProjection & { attribution_degraded?: { unmerged_paths: string[] } }
    >(repo.path, plan.artifact_id, 1);
    expect(proj.diff_fingerprint_summary.error_reason).toBeNull();
    expect(proj.diff_fingerprint_summary.status).toBe('captured');
    expect(proj.attribution_degraded).toEqual({ unmerged_paths: ['conflict.txt'] });

    // Manifest: unrelated file's hunks present, conflicted path's absent,
    // counts consistent with the summary.
    const payload = await readLatestCheckpointClosedPayload(repo.path, plan.artifact_id, 1);
    const hunks = (payload.diff_fingerprint_manifest?.hunks ?? []) as Array<{
      file_before: string | null;
      file_after: string | null;
    }>;
    expect(hunks.some((h) => h.file_after === 'other.ts')).toBe(true);
    expect(
      hunks.some((h) => h.file_before === 'conflict.txt' || h.file_after === 'conflict.txt')
    ).toBe(false);
    expect(payload.diff_fingerprint_summary.hunk_count).toBe(hunks.length);

    // Derive round-trip: the re-derived (unfiltered) manifest replays the
    // recorded exclusion and reproduces the stored hash.
    const derived = parseOk<OkEnvelope & { verified: boolean | null }>(
      await agent.runRaw([
        'fingerprint',
        'derive',
        '--artifact',
        plan.artifact_id,
        '--checkpoint',
        '1',
        '--json',
      ])
    );
    expect(derived.verified).toBe(true);
  });

  it('conflict introduced after open does not erase unrelated attribution', async () => {
    const plan = await capturePlan(['step a']);
    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));

    await writeFile(path.join(repo.path, 'other.ts'), 'export const other = 2;\n', 'utf8');
    forgeConflict(repo.path, 'late-conflict.txt');

    const c = parseOk<OkEnvelope & { warnings?: WarningEntry[] }>(
      await closeCp({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'conflict appeared mid-window',
        files_changed: ['other.ts'],
        completed_step_ids: [plan.step_ids[0]],
      })
    );
    expect(findWarning(c.warnings, 'unmerged-paths-degraded')?.message).toContain(
      'late-conflict.txt'
    );

    const proj = await readCheckpointProjection<
      ClosedCheckpointProjection & { attribution_degraded?: { unmerged_paths: string[] } }
    >(repo.path, plan.artifact_id, 1);
    expect(proj.attribution_degraded).toEqual({ unmerged_paths: ['late-conflict.txt'] });
    const payload = await readLatestCheckpointClosedPayload(repo.path, plan.artifact_id, 1);
    const hunks = (payload.diff_fingerprint_manifest?.hunks ?? []) as Array<{
      file_before: string | null;
      file_after: string | null;
    }>;
    expect(hunks.some((h) => h.file_after === 'other.ts')).toBe(true);
    expect(hunks.some((h) => h.file_after === 'late-conflict.txt')).toBe(false);
  });

  it('different conflicts at open and close → the union is recorded', async () => {
    const plan = await capturePlan(['step a']);

    forgeConflict(repo.path, 'a-conflict.txt');
    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));
    resolveConflict(repo.path, 'a-conflict.txt', 'a resolved\n');
    forgeConflict(repo.path, 'b-conflict.txt');

    parseOk(
      await closeCp({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'two conflicts across the window',
        files_changed: [],
        completed_step_ids: [plan.step_ids[0]],
      })
    );
    const proj = await readCheckpointProjection<
      ClosedCheckpointProjection & { attribution_degraded?: { unmerged_paths: string[] } }
    >(repo.path, plan.artifact_id, 1);
    expect(proj.attribution_degraded).toEqual({
      unmerged_paths: ['a-conflict.txt', 'b-conflict.txt'],
    });
  });

  it('replayed close re-emits the degraded warning; replayed open stays quiet', async () => {
    const plan = await capturePlan(['step a']);

    forgeConflict(repo.path, 'conflict.txt');
    const openKey = `open-${randomUUID()}`;
    const o1 = parseOk<OkEnvelope & { warnings?: WarningEntry[] }>(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'open',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: openKey,
            artifact_id: plan.artifact_id,
            declared_step_ids: [plan.step_ids[0]],
          })
        ),
      ])
    );
    expect(findWarning(o1.warnings, 'unmerged-paths-degraded')).toBeDefined();

    // Replayed open: quiet (nothing was re-captured; live state is
    // status/doctor's job).
    const o2 = parseOk<OkEnvelope & { warnings?: WarningEntry[] }>(
      await agent.runRaw([
        'capture',
        'checkpoint',
        'open',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: openKey,
            artifact_id: plan.artifact_id,
            declared_step_ids: [plan.step_ids[0]],
          })
        ),
      ])
    );
    expect(findWarning(o2.warnings, 'unmerged-paths-degraded')).toBeUndefined();

    const closeKey = `close-${randomUUID()}`;
    const closePayload = {
      artifact_id: plan.artifact_id,
      n: 1,
      summary: 'close under conflict',
      files_changed: [],
      completed_step_ids: [plan.step_ids[0]],
    };
    const c1 = parseOk<OkEnvelope & { warnings?: WarningEntry[] }>(
      await closeCp(closePayload, closeKey)
    );
    expect(findWarning(c1.warnings, 'unmerged-paths-degraded')).toBeDefined();

    // Replayed close: re-derived from the persisted attribution_degraded.
    const c2 = parseOk<OkEnvelope & { warnings?: WarningEntry[] }>(
      await closeCp(closePayload, closeKey)
    );
    expect(findWarning(c2.warnings, 'unmerged-paths-degraded')).toBeDefined();
  });

  it('abandon under conflict → degraded warning + populated boundary', async () => {
    const plan = await capturePlan(['step a']);
    forgeConflict(repo.path, 'conflict.txt');
    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));

    const a = parseOk<OkEnvelope & { warnings?: WarningEntry[] }>(
      await abandonCp({ artifact_id: plan.artifact_id, n: 1, reason: 'rescope' })
    );
    expect(findWarning(a.warnings, 'unmerged-paths-degraded')?.message).toContain('conflict.txt');

    const proj = await readCheckpointProjection<AbandonedCheckpointProjection>(
      repo.path,
      plan.artifact_id,
      1
    );
    expect(proj.abandon_snapshot.tree_sha).not.toBeNull();
    expect(proj.abandon_snapshot.snapshot_error_reason).toBeNull();
  });

  it('a baseline captured mid-conflict BLOCKS seed recovery', async () => {
    // Conflict exists at PLAN time (the seed baseline carries marker bytes),
    // is resolved before the checkpoint opens, and the claimed work lands
    // before open. Without the block, seed recovery would attribute the
    // marker→resolution hunks to cp 1 with no boundary-time union to filter
    // them — so recovery must not run at all.
    forgeConflict(repo.path, 'conflict.txt');
    const plan = await capturePlan(['step a']);

    resolveConflict(repo.path, 'conflict.txt', 'resolved before open\n');
    await writeFile(path.join(repo.path, 'pre.ts'), 'export const pre = 1;\n', 'utf8');
    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));

    const c = parseOk<OkEnvelope & { warnings?: WarningEntry[] }>(
      await closeCp({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'work landed before open, seed was conflicted',
        files_changed: ['pre.ts'],
        completed_step_ids: [plan.step_ids[0]],
      })
    );
    // The empty-window warning still fires (behaviour signal), but the
    // fingerprint stays EMPTY — no seed-recovered manifest.
    expect(findWarning(c.warnings, 'empty-diff-window')).toBeDefined();
    const proj = await readCheckpointProjection<
      ClosedCheckpointProjection & { attribution_degraded?: { unmerged_paths: string[] } }
    >(repo.path, plan.artifact_id, 1);
    expect(proj.diff_fingerprint_summary.status).toBe('empty');
    // No boundary was conflicted, so no degraded record either.
    expect(proj.attribution_degraded).toBeUndefined();
  });

  it('fence-empty recovery keeps the conflicted claimed path excluded', async () => {
    // Plan (clean seed baseline) → conflict + pre-open edit land BEFORE the
    // open → open/close fence is empty → recovery re-diffs seed→close scoped
    // to files_changed. The conflicted path is claimed, so the recovered
    // manifest would carry its marker hunks — the store-side exclusion must
    // filter them while keeping the pre-open edit attributable.
    const plan = await capturePlan(['step a']);

    forgeConflict(repo.path, 'conflict.txt');
    await writeFile(path.join(repo.path, 'pre.ts'), 'export const pre = 1;\n', 'utf8');
    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));

    const c = parseOk<OkEnvelope & { warnings?: WarningEntry[] }>(
      await closeCp({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'work landed before open',
        files_changed: ['pre.ts', 'conflict.txt'],
        completed_step_ids: [plan.step_ids[0]],
      })
    );
    expect(findWarning(c.warnings, 'empty-diff-window')).toBeDefined();
    expect(findWarning(c.warnings, 'unmerged-paths-degraded')).toBeDefined();

    const proj = await readCheckpointProjection<
      ClosedCheckpointProjection & { attribution_degraded?: { unmerged_paths: string[] } }
    >(repo.path, plan.artifact_id, 1);
    expect(proj.attribution_degraded).toEqual({ unmerged_paths: ['conflict.txt'] });
    const payload = await readLatestCheckpointClosedPayload(repo.path, plan.artifact_id, 1);
    const hunks = (payload.diff_fingerprint_manifest?.hunks ?? []) as Array<{
      file_before: string | null;
      file_after: string | null;
    }>;
    expect(hunks.some((h) => h.file_after === 'pre.ts')).toBe(true);
    expect(
      hunks.some((h) => h.file_before === 'conflict.txt' || h.file_after === 'conflict.txt')
    ).toBe(false);
    expect(payload.diff_fingerprint_summary.hunk_count).toBe(hunks.length);
  });

  it('truncation: max_diff_bytes=1024 → status=truncated with cap_exceeded reason', async () => {
    // Init runs first (writes default config); we then overwrite the
    // config with a tiny max_diff_bytes BEFORE the close. Each capture
    // call re-reads config from disk so the override takes effect.
    const plan = await capturePlan(['step a']);

    // Shrink the cap. resolveConfig deep-merges with defaults so a
    // partial override is sufficient.
    const configPath = path.join(repo.path, '.orcaops', 'config.json');
    const existing = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    const merged = {
      ...existing,
      diff_fingerprint: { enabled: true, max_diff_bytes: 1024 },
    };
    await writeFile(configPath, JSON.stringify(merged, null, 2), 'utf8');

    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));

    // Write a large file with many distinct lines so the unified diff
    // far exceeds 1024 bytes. Each line is ~50 chars × 4000 lines =
    // ~200 KB. The diff itself (with the +prefix on each line) is
    // bigger still. Cap will trigger.
    const lines: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      lines.push(`export const item_${i} = { idx: ${i}, label: "row number ${i} here" };`);
    }
    await commitFile(repo.path, 'src/large.ts', `${lines.join('\n')}\n`, 'big file');

    parseOk(
      await closeCp({
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'cp1 large change',
        files_changed: ['src/large.ts'],
        completed_step_ids: [plan.step_ids[0]],
      })
    );

    const proj = await readCheckpointProjection<ClosedCheckpointProjection>(
      repo.path,
      plan.artifact_id,
      1
    );
    expect(proj.diff_fingerprint_summary.status).toBe('truncated');
    expect(proj.diff_fingerprint_summary.truncated).toBe(true);
    expect(proj.diff_fingerprint_summary.error_reason).toBe('cap_exceeded');
    // captured_hunk_count <= hunk_count (the builder drops the partial
    // trailing hunk; for a single-file large diff this typically means
    // captured == hunk_count with truncated:true flagging the cut).
    expect(proj.diff_fingerprint_summary.captured_hunk_count).toBeLessThanOrEqual(
      proj.diff_fingerprint_summary.hunk_count
    );
  });

  it('CLI close envelope contains no raw diff/patch text', async () => {
    const plan = await capturePlan(['step a']);
    parseOk(await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] }));
    await commitFile(
      repo.path,
      'src/foo.ts',
      'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n',
      'add foo'
    );

    const closeResult = await closeCp({
      artifact_id: plan.artifact_id,
      n: 1,
      summary: 'cp1',
      files_changed: ['src/foo.ts'],
      completed_step_ids: [plan.step_ids[0]],
    });
    expect(closeResult.exitCode).toBe(0);
    const envelope = JSON.parse(closeResult.stdout) as Record<string, unknown>;
    expect(envelope.ok).toBe(true);

    // No top-level or nested keys that would carry raw text. Visit
    // every key in the parsed JSON tree and assert none match the
    // raw-text key set.
    const FORBIDDEN_KEYS = new Set([
      'diff',
      'patch',
      'diff_text',
      'patch_text',
      'raw_diff',
      'raw_patch',
    ]);
    function visit(node: unknown): void {
      if (node === null) return;
      if (typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        expect(FORBIDDEN_KEYS.has(k), `forbidden key "${k}" in CLI envelope`).toBe(false);
        visit(v);
      }
    }
    visit(envelope);

    // No unified-diff line markers in the stringified envelope. The
    // load-bearing assertion: a unified diff has either a hunk header
    // (`@@ -X,Y +A,B @@`) or file headers (`--- a/path`, `+++ b/path`).
    // None of these can legitimately appear in the close envelope.
    const stringified = JSON.stringify(envelope);
    expect(stringified).not.toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(stringified).not.toContain('--- a/');
    expect(stringified).not.toContain('+++ b/');
  });

  // ── empty-window warning + recovery e2e ─────────────────────────────
  //
  // These exercise the work-BEFORE-open failure mode end-to-end through the
  // real local CLI. The `beforeEach` already seeds a fresh cloud login + the
  // plan-time baseline (capturePlan → `capture plan` captures the baseline
  // seed), so the first work-before-open cp recovers from the seed and
  // later ones recover from the HWM (prior cp's close tree).
  //
  // Warning shape: a NON-blocking `warnings: [{ code:'empty-diff-window', ... }]`
  // on the close JSON, keyed on TREE EQUALITY (open==close) AND files_changed>0.
  // Recovery is silent salvage: it rewrites the diff_fingerprint manifest's base
  // tree to the baseline (so status flips empty→captured) WITHOUT moving the
  // checkpoint's real open/close snapshot boundary.
  describe('snapshot-reliability — empty-window warning + recovery', () => {
    type CloseEnvelope = OkEnvelope & {
      warnings?: Array<{ code: string; message: string }>;
      idempotency_status?: string;
    };

    function hasEmptyDiffWarning(env: CloseEnvelope): boolean {
      return (env.warnings ?? []).some((w) => w.code === 'empty-diff-window');
    }

    // Multi-line so the recovered diff has real added-line hunks (a 1-line
    // file would still produce a hunk, but multi-line makes hunk_count>0
    // unambiguous and mirrors the audited "real work" fixtures).
    const body = (tag: string): string =>
      [
        `export const ${tag}_a = 1;`,
        `export const ${tag}_b = 2;`,
        `export const ${tag}_c = 3;`,
        `export function ${tag}_fn() {`,
        `  return ${tag}_a + ${tag}_b + ${tag}_c;`,
        `}`,
        '',
      ].join('\n');

    it('supersession adopts the superseded pre-work tree as the recovery seed + repins the baseline ref', async () => {
      // Artifact A: capture, then an UNCOMMITTED change so A's OPEN tree (Tsup) is
      // NOT reachable via git history and differs from A's plan-time baseline.
      const planA = await capturePlan(['step a']);
      await writeFile(path.join(repo.path, 'a-pre.ts'), body('apre'), 'utf8');
      parseOk(
        await openCp({ artifact_id: planA.artifact_id, declared_step_ids: [planA.step_ids[0]] })
      );
      const projA = await readCheckpointProjection<{ open_snapshot: { tree_sha: string | null } }>(
        repo.path,
        planA.artifact_id,
        1
      );
      const tsup = projA.open_snapshot.tree_sha;
      expect(tsup).not.toBeNull();
      // Another uncommitted change so B's plan-time tree differs from Tsup (the
      // override must not be a no-op).
      await writeFile(path.join(repo.path, 'a-post.ts'), body('apost'), 'utf8');

      // Artifact B: a --source-plan re-capture. B detects A (the single other
      // in-flight artifact with an open cp) → adopts A's open tree (Tsup) as B's
      // recovery seed AND repins refs/orcaops/baseline/<B> to Tsup.
      const slicePlan = path.join(repo.path, 'slice.md');
      await writeFile(slicePlan, '# slice\nstep b\n', 'utf8');
      const rB = parseOk<
        OkEnvelope & { artifact_id: string; plan_steps: Array<{ step_id: string }> }
      >(
        await agent.runRaw([
          'capture',
          'plan',
          '--no-llm',
          '--source-plan',
          slicePlan,
          '--input',
          inputFile(
            JSON.stringify({
              idempotency_key: `planB-${randomUUID()}`,
              task: 'superseding re-capture',
              label: 'supersede-test',
              plan_steps: [{ text: 'step b', label: 'sb' }],
              touched_scope: [],
            })
          ),
        ])
      );
      const bId = rB.artifact_id;

      // Direct proof of the repin: B's OWN baseline ref now wraps Tsup (= A's open
      // tree), not B's plan-time tree.
      const bRefTree = execFileSync('git', ['rev-parse', `${baselineRefName(bId)}^{tree}`], {
        cwd: repo.path,
        encoding: 'utf8',
      }).trim();
      expect(bRefTree).toBe(tsup);

      // The override adopted A's pre-work tree (Tsup) as B's recovery
      // baseline_seed_tree_sha AND repinned B's OWN baseline ref to it (asserted
      // above), recording A as superseded — so the seed survives even after A's
      // refs are pruned. Without the repin, the bRefTree assertion above fails;
      // without the override, the seed below fails. (Recovery FROM a seed is
      // covered by the SEED scenario above; the repinned ref keeping that tree
      // reachable through a ref-prune + git gc is the pinBaselineTree unit test in
      // snapshots.test.ts.)
      const bJson = JSON.parse(
        await readFile(path.join(repo.path, '.orcaops', 'artifacts', bId, 'artifact.json'), 'utf8')
      ) as { baseline_seed_tree_sha: string | null; superseded_artifact_id: string | null };
      expect(bJson.baseline_seed_tree_sha).toBe(tsup);
      expect(bJson.superseded_artifact_id).toBe(planA.artifact_id);
    });

    it('a rotted sibling keeps the plan-time baseline (rot never picks the supersession winner)', async () => {
      const planA = await capturePlan(['step a']);
      await writeFile(path.join(repo.path, 'a-pre.ts'), body('apre'), 'utf8');
      parseOk(
        await openCp({ artifact_id: planA.artifact_id, declared_step_ids: [planA.step_ids[0]] })
      );

      // Rot A's checkpoint_opened line AND delete its projection: the loss
      // is unattributable, so the recovery-aware checkpoint scan refuses A.
      const aDir = path.join(repo.path, '.orcaops', 'artifacts', planA.artifact_id);
      const aLog = path.join(aDir, 'events.ndjson');
      const lines = (await readFile(aLog, 'utf8')).split('\n');
      const i = lines.findIndex((l) => l.includes('"checkpoint_opened"'));
      lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
      await writeFile(aLog, lines.join('\n'), 'utf8');
      await rm(path.join(aDir, 'checkpoint-1.json'));

      const slicePlan = path.join(repo.path, 'slice-rot.md');
      await writeFile(slicePlan, '# slice\nstep b\n', 'utf8');
      const res = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--source-plan',
        slicePlan,
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `planB-rot-${randomUUID()}`,
            task: 'superseding re-capture over a rotted sibling',
            label: 'supersede-rot-test',
            plan_steps: [{ text: 'step b', label: 'sb' }],
            touched_scope: [],
          })
        ),
      ]);
      const rB = parseOk<OkEnvelope & { artifact_id: string }>(res);
      expect(res.stderr).toContain('skipping unreadable in-flight artifact');

      // The unreadable sibling counted as ambiguity: no supersession, no
      // adopted tree — the plan-time baseline stands.
      const bJson = JSON.parse(
        await readFile(
          path.join(repo.path, '.orcaops', 'artifacts', rB.artifact_id, 'artifact.json'),
          'utf8'
        )
      ) as { superseded_artifact_id: string | null };
      expect(bJson.superseded_artifact_id).toBeNull();
    });

    it('a containment violation in the sibling scan propagates — and the key is not stranded', async () => {
      const planA = await capturePlan(['step a']);
      parseOk(
        await openCp({ artifact_id: planA.artifact_id, declared_step_ids: [planA.step_ids[0]] })
      );
      // A symlinked artifact.json is a containment violation, not
      // recovery refusal: the scan must NOT relabel it as an unreadable
      // sibling — the capture fails loudly instead.
      const aDir = path.join(repo.path, '.orcaops', 'artifacts', planA.artifact_id);
      await rm(path.join(aDir, 'artifact.json'));
      await symlink('/etc/hosts', path.join(aDir, 'artifact.json'));

      const slicePlan = path.join(repo.path, 'slice-symlink.md');
      await writeFile(slicePlan, '# slice\nstep b\n', 'utf8');
      const key = `planB-symlink-${randomUUID()}`;
      const args = [
        'capture',
        'plan',
        '--no-llm',
        '--source-plan',
        slicePlan,
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: key,
            task: 'capture beside a symlinked sibling',
            label: 'symlink-propagation-test',
            plan_steps: [{ text: 'step b', label: 'sb' }],
            touched_scope: [],
          })
        ),
      ];
      const res = await agent.runRaw(args);
      expect(res.exitCode).not.toBe(0);

      // The reservation was rolled back: after healing the sibling, the
      // SAME key mints a real, planned artifact — not a planless replay.
      await rm(path.join(aDir, 'artifact.json'));
      const retry = parseOk<OkEnvelope & { artifact_id: string }>(await agent.runRaw(args));
      const bPlan = JSON.parse(
        await readFile(
          path.join(repo.path, '.orcaops', 'artifacts', retry.artifact_id, 'plan.json'),
          'utf8'
        )
      ) as { task: string };
      expect(bPlan.task).toBe('capture beside a symlinked sibling');
    });

    it('a sibling whose artifact.json read refuses cannot fail the capture or strand its key', async () => {
      const planA = await capturePlan(['step a']);
      parseOk(
        await openCp({ artifact_id: planA.artifact_id, declared_step_ids: [planA.step_ids[0]] })
      );
      // Make A's readArtifact itself refuse: delete artifact.json and rot
      // a line, so the loss is unattributable and the projection absent —
      // the enumeration guard (not just the checkpoint guard) must catch.
      const aDir = path.join(repo.path, '.orcaops', 'artifacts', planA.artifact_id);
      const lines = (await readFile(path.join(aDir, 'events.ndjson'), 'utf8')).split('\n');
      const i = lines.findIndex((l) => l.includes('"checkpoint_opened"'));
      lines[i] = lines[i].replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`);
      await writeFile(path.join(aDir, 'events.ndjson'), lines.join('\n'), 'utf8');
      await rm(path.join(aDir, 'artifact.json'));
      await rm(path.join(aDir, 'checkpoint-1.json'));

      const slicePlan = path.join(repo.path, 'slice-rot2.md');
      await writeFile(slicePlan, '# slice\nstep b\n', 'utf8');
      const key = `planB-strand-${randomUUID()}`;
      const args = [
        'capture',
        'plan',
        '--no-llm',
        '--source-plan',
        slicePlan,
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: key,
            task: 'capture beside an unreadable sibling',
            label: 'strand-test',
            plan_steps: [{ text: 'step b', label: 'sb' }],
            touched_scope: [],
          })
        ),
      ];
      const res = await agent.runRaw(args);
      const rB = parseOk<OkEnvelope & { artifact_id: string }>(res);
      expect(res.stderr).toContain('skipping unreadable in-flight artifact');

      // The key maps to a real, planned artifact: a same-key retry replays
      // the SAME artifact instead of a planless husk.
      const retry = parseOk<OkEnvelope & { artifact_id: string }>(await agent.runRaw(args));
      expect(retry.artifact_id).toBe(rB.artifact_id);
      const bPlan = JSON.parse(
        await readFile(
          path.join(repo.path, '.orcaops', 'artifacts', rB.artifact_id, 'plan.json'),
          'utf8'
        )
      ) as { task: string };
      expect(bPlan.task).toBe('capture beside an unreadable sibling');
    });

    it('work-before-open → warning + recovery from the plan-time SEED, then HWM chain', async () => {
      const plan = await capturePlan(['step a', 'step b']);

      // Work BEFORE opening cp1 → the open/close fence will be empty.
      await commitFile(repo.path, 'src/a.ts', body('a'), 'work a (before open)');

      parseOk(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
      );
      const closed1 = parseOk<CloseEnvelope>(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1 claims step a (work landed before open)',
          files_changed: ['src/a.ts'],
          completed_step_ids: [plan.step_ids[0]],
        })
      );

      // (1) The empty-window warning fired.
      expect(hasEmptyDiffWarning(closed1)).toBe(true);

      const proj1 = await readCheckpointProjection<ClosedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        1
      );
      // (2) Recovery salvaged the attribution FROM THE PLAN-TIME SEED (the
      // first-cp case): status flipped to 'captured' with real hunks.
      expect(proj1.diff_fingerprint_summary.status).toBe('captured');
      expect(proj1.diff_fingerprint_summary.hunk_count).toBeGreaterThan(0);
      // (3) The REAL fence was empty — recovery rewrote only the manifest, NOT
      // the checkpoint's snapshot boundary, so open==close on the projection.
      expect(proj1.open_snapshot.tree_sha).not.toBeNull();
      expect(proj1.open_snapshot.tree_sha).toEqual(proj1.close_snapshot.tree_sha);

      // (4) The recovered MANIFEST's own open_tree_sha is the baseline (≠ the
      // checkpoint's real open tree) — the documented recovery divergence.
      const payload1 = await readLatestCheckpointClosedPayload(repo.path, plan.artifact_id, 1);
      expect(payload1.diff_fingerprint_manifest).toBeDefined();
      const recoveredOpenTree = (payload1.diff_fingerprint_manifest as { open_tree_sha?: string })
        .open_tree_sha;
      expect(recoveredOpenTree).toBeDefined();
      expect(recoveredOpenTree).not.toEqual(proj1.open_snapshot.tree_sha);
      // And the manifest's close tree IS the real close (recovery preserves it).
      expect(
        (payload1.diff_fingerprint_manifest as { close_tree_sha?: string }).close_tree_sha
      ).toEqual(proj1.close_snapshot.tree_sha);

      // ── Second work-before-open cp → exercise the HWM chain (recover from
      //    cp1's close tree, not the seed). ──
      await commitFile(repo.path, 'src/b.ts', body('b'), 'work b (before open)');
      parseOk(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[1]] })
      );
      const closed2 = parseOk<CloseEnvelope>(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 2,
          summary: 'cp2 claims step b (work landed before open)',
          files_changed: ['src/b.ts'],
          completed_step_ids: [plan.step_ids[1]],
        })
      );
      expect(hasEmptyDiffWarning(closed2)).toBe(true);

      const proj2 = await readCheckpointProjection<ClosedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        2
      );
      // Recovered from the HWM (cp1's close tree) → captured with hunks.
      expect(proj2.diff_fingerprint_summary.status).toBe('captured');
      expect(proj2.diff_fingerprint_summary.hunk_count).toBeGreaterThan(0);
      expect(proj2.open_snapshot.tree_sha).toEqual(proj2.close_snapshot.tree_sha);
    });

    it('verification-only close (files_changed:[]) → NO warning, status empty', async () => {
      const plan = await capturePlan(['step a']);
      // Correctly opened (before any work), and no work happens at all.
      parseOk(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
      );
      const closed = parseOk<CloseEnvelope>(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1 verification only',
          files_changed: [],
          completed_step_ids: [plan.step_ids[0]],
        })
      );

      // Invariant 2: the warning keys on files_changed>0, so an empty
      // files_changed never warns even though the fence is empty.
      expect(closed.warnings).toBeUndefined();
      const proj = await readCheckpointProjection<ClosedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        1
      );
      expect(proj.diff_fingerprint_summary.status).toBe('empty');
    });

    it('correctly-opened control (work AFTER open) → captured, NO warning, real fence', async () => {
      const plan = await capturePlan(['step a']);
      parseOk(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
      );
      // Work happens AFTER open → the fence is non-empty.
      await commitFile(repo.path, 'src/c.ts', body('c'), 'work c (after open)');
      const closed = parseOk<CloseEnvelope>(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1 normal cadence',
          files_changed: ['src/c.ts'],
          completed_step_ids: [plan.step_ids[0]],
        })
      );

      expect(closed.warnings).toBeUndefined();
      const proj = await readCheckpointProjection<ClosedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        1
      );
      expect(proj.diff_fingerprint_summary.status).toBe('captured');
      expect(proj.diff_fingerprint_summary.hunk_count).toBeGreaterThan(0);
      // Real non-empty fence: open != close (the normal captured path).
      expect(proj.open_snapshot.tree_sha).not.toBeNull();
      expect(proj.open_snapshot.tree_sha).not.toEqual(proj.close_snapshot.tree_sha);
    });

    it('concurrency guard (LIVE overlap) → warning fires, recovery BLOCKED (status empty)', async () => {
      const plan = await capturePlan(['step a', 'step b']);
      // Work BEFORE either open → empty fence for the cp we close.
      await commitFile(repo.path, 'src/x.ts', body('x'), 'work x (before opens)');

      // Two concurrently-open cps over the SAME post-work tree. Distinct
      // agent_session_id keeps them legible as separate subagent windows.
      parseOk(
        await openCp({
          artifact_id: plan.artifact_id,
          declared_step_ids: [plan.step_ids[0]],
          agent_session_id: 'sess-a',
        })
      );
      parseOk(
        await openCp({
          artifact_id: plan.artifact_id,
          declared_step_ids: [plan.step_ids[1]],
          agent_session_id: 'sess-b',
        })
      );

      const closed1 = parseOk<CloseEnvelope>(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1 closes while cp2 is open',
          files_changed: ['src/x.ts'],
          completed_step_ids: [plan.step_ids[0]],
        })
      );

      // The warning still fires (it is independent of recovery)...
      expect(hasEmptyDiffWarning(closed1)).toBe(true);
      const proj1 = await readCheckpointProjection<ClosedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        1
      );
      // ...but recovery was BLOCKED by the interval overlap with cp2, so the
      // status stays 'empty' (no salvage).
      expect(proj1.diff_fingerprint_summary.status).toBe('empty');
    });

    it('concurrency guard (HISTORICAL overlap) → warning fires, recovery BLOCKED even after the overlapping cp finalized', async () => {
      const plan = await capturePlan(['step a', 'step b']);
      await commitFile(repo.path, 'src/x.ts', body('x'), 'work x (before opens)');

      // cp1 and cp2 open concurrently (intervals overlap).
      parseOk(
        await openCp({
          artifact_id: plan.artifact_id,
          declared_step_ids: [plan.step_ids[0]],
          agent_session_id: 'sess-a',
        })
      );
      parseOk(
        await openCp({
          artifact_id: plan.artifact_id,
          declared_step_ids: [plan.step_ids[1]],
          agent_session_id: 'sess-b',
        })
      );

      // cp1 closes FIRST (and is now finalized/historical).
      parseOk(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1 closes first',
          files_changed: ['src/x.ts'],
          completed_step_ids: [plan.step_ids[0]],
        })
      );

      // cp2 closes over an empty fence. Its interval overlapped cp1's, so even
      // though cp1 is already finalized, recovery is blocked.
      const closed2 = parseOk<CloseEnvelope>(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 2,
          summary: 'cp2 closes over an empty fence',
          files_changed: ['src/x.ts'],
          completed_step_ids: [plan.step_ids[1]],
        })
      );

      expect(hasEmptyDiffWarning(closed2)).toBe(true);
      const proj2 = await readCheckpointProjection<ClosedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        2
      );
      expect(proj2.diff_fingerprint_summary.status).toBe('empty');
    });

    it('no recoverable baseline (seed already contains the file) → warning fires, recovery silent (status empty)', async () => {
      // Pre-plan work: the file is committed BEFORE capture plan, so the
      // plan-time baseline SEED already contains it. The fence is then empty
      // (work predates open) AND the scoped diff(seed→close) is also empty —
      // recovery has nothing to salvage. This is the residual "recovery can't
      // rescue" case: the warning still fires, but status stays 'empty'.
      await commitFile(repo.path, 'src/pre.ts', body('pre'), 'pre-plan work');
      const plan = await capturePlan(['step a']);

      parseOk(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
      );
      const closed = parseOk<CloseEnvelope>(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1 claims a file that predates the plan baseline',
          files_changed: ['src/pre.ts'],
          completed_step_ids: [plan.step_ids[0]],
        })
      );

      expect(hasEmptyDiffWarning(closed)).toBe(true);
      const proj = await readCheckpointProjection<ClosedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        1
      );
      expect(proj.diff_fingerprint_summary.status).toBe('empty');
    });

    it('idempotent replay re-emits the warning (re-derived from persisted tree equality)', async () => {
      const plan = await capturePlan(['step a']);
      await commitFile(repo.path, 'src/a.ts', body('a'), 'work a (before open)');
      parseOk(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
      );

      const closeKey = `close-${randomUUID()}`;
      const closePayload = {
        artifact_id: plan.artifact_id,
        n: 1,
        summary: 'cp1 claims step a (recovered)',
        files_changed: ['src/a.ts'],
        completed_step_ids: [plan.step_ids[0]],
      };

      // First close: warns + recovers.
      const first = parseOk<CloseEnvelope>(await closeCp(closePayload, closeKey));
      expect(hasEmptyDiffWarning(first)).toBe(true);
      const proj = await readCheckpointProjection<ClosedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        1
      );
      // Sanity: recovery DID set status to captured, so the replay branch must
      // re-derive the warning from tree equality (NOT proxy on summary.status,
      // which is now 'captured' ≠ empty).
      expect(proj.diff_fingerprint_summary.status).toBe('captured');

      // Replay with the same key + payload.
      const replay = parseOk<CloseEnvelope>(await closeCp(closePayload, closeKey));
      expect(replay.idempotency_status).toBe('replay');
      // The replay path re-emits the warning from the PERSISTED open/close tree
      // equality — the boundaries survived recovery (recovery only rewrote the
      // manifest base tree).
      expect(hasEmptyDiffWarning(replay)).toBe(true);
    });

    it('truncated-but-real in-window change → NO warning, NO recovery (fenceEmpty uses tree equality, not hunk_count)', async () => {
      // Regression guard: a correctly-opened cp with a LARGE in-window
      // change truncates to hunk_count===0, but the fence is NOT empty (open !=
      // close). fenceEmpty must key on tree equality, so NO warning fires and NO
      // recovery runs.
      const plan = await capturePlan(['step a']);

      // Shrink the diff cap so the large change truncates. resolveConfig
      // deep-merges with defaults, so a partial override suffices; each capture
      // re-reads config from disk. (Same knob the existing truncation test uses.)
      const configPath = path.join(repo.path, '.orcaops', 'config.json');
      const existing = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      await writeFile(
        configPath,
        JSON.stringify(
          { ...existing, diff_fingerprint: { enabled: true, max_diff_bytes: 1024 } },
          null,
          2
        ),
        'utf8'
      );

      parseOk(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
      );

      // Large in-window change (~200 KB of unique lines) — well over the 1 KB cap.
      const lines: string[] = [];
      for (let i = 0; i < 4000; i += 1) {
        lines.push(`export const item_${i} = { idx: ${i}, label: "row number ${i} here" };`);
      }
      await commitFile(repo.path, 'src/big.ts', `${lines.join('\n')}\n`, 'big in-window change');

      const closed = parseOk<CloseEnvelope>(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1 large change (after open)',
          files_changed: ['src/big.ts'],
          completed_step_ids: [plan.step_ids[0]],
        })
      );

      const proj = await readCheckpointProjection<ClosedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        1
      );
      // Truncated (cap exceeded) with zero captured hunks...
      expect(proj.diff_fingerprint_summary.status).toBe('truncated');
      expect(proj.diff_fingerprint_summary.hunk_count).toBe(0);
      // ...yet NO warning: the fence is real (open != close), so fenceEmpty is
      // false. This is the exact regression the tree-equality key prevents.
      expect(closed.warnings).toBeUndefined();
      expect(proj.open_snapshot.tree_sha).not.toEqual(proj.close_snapshot.tree_sha);
    });

    it('recovery that truncates to 0 hunks falls through to empty (NOT a misleading "truncated")', async () => {
      // Empty-fence recovery against the plan-time seed, but with a tiny diff cap
      // the scoped recovery diff(seed→close) TRUNCATES to zero captured hunks.
      // Accepting on `manifest != null && status ∈ {captured, truncated}`
      // alone would flip the cp to status 'truncated' — looks accounted-for
      // yet carries no per-line attribution. The `hunk_count > 0` guard must
      // reject it and fall through to the empty summary, warning intact.
      const plan = await capturePlan(['step a']);

      // Shrink the diff cap (deep-merge override; each capture re-reads config).
      const configPath = path.join(repo.path, '.orcaops', 'config.json');
      const existing = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      await writeFile(
        configPath,
        JSON.stringify(
          { ...existing, diff_fingerprint: { enabled: true, max_diff_bytes: 1024 } },
          null,
          2
        ),
        'utf8'
      );

      // Large change committed AFTER the plan baseline but BEFORE open → the
      // fence is empty (work predates open) and the recovery diff is ~200 KB,
      // well over the 1 KB cap, so the salvage truncates to 0 hunks.
      const lines: string[] = [];
      for (let i = 0; i < 4000; i += 1) {
        lines.push(`export const item_${i} = { idx: ${i}, label: "row number ${i} here" };`);
      }
      await commitFile(repo.path, 'src/big.ts', `${lines.join('\n')}\n`, 'big work before open');

      parseOk(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
      );
      const closed = parseOk<CloseEnvelope>(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1 large pre-open change; recovery diff truncates',
          files_changed: ['src/big.ts'],
          completed_step_ids: [plan.step_ids[0]],
        })
      );

      // The empty-fence warning still fires (the fence is genuinely empty)...
      expect(hasEmptyDiffWarning(closed)).toBe(true);
      const proj = await readCheckpointProjection<ClosedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        1
      );
      // ...and the truncated-to-0-hunk salvage is REJECTED: status stays 'empty'
      // (NOT 'truncated') with zero hunks — the regression this guard prevents.
      expect(proj.diff_fingerprint_summary.status).toBe('empty');
      expect(proj.diff_fingerprint_summary.hunk_count).toBe(0);
      // The fence really is empty (open == close), confirming recovery — not the
      // in-window path — is what the guard rejected.
      expect(proj.open_snapshot.tree_sha).toEqual(proj.close_snapshot.tree_sha);
    });
  });

  // ── Snapshot-capture failure diagnostics ────────────────────────────────
  //
  // The persisted boundary can hold nothing but the typed reason, and 'unknown'
  // names nothing: a boundary that fails this way records only
  // `snapshot_error_reason: "unknown"`, and the git stderr — present at the
  // failure — is lost if the CLI's `toBoundary` mapper drops it. These pin
  // the contract: the raw stderr on the response's `warnings[]`, at the moment of
  // failure, on BOTH lifecycle boundaries (open is the consequential one — a
  // failed open poisons the close fingerprint via 'missing_open_tree_sha' long
  // after anyone could connect the two).
  //
  // Induced failure: a REQUIRED clean filter that always exits non-zero aborts
  // `git add` at step 8 of the capture pipeline — AFTER the unborn-repo and
  // merge-conflict short-circuits, so the result routes through
  // `classifySnapshotFailure` and lands on 'unknown' WITH a real stderr, which
  // is exactly the failure class this whole surface exists for. (Same fixture as
  // the post-allocation failure test in packages/core/src/git/snapshots.test.ts.)
  // It breaks plain `git add` too, so it is installed only after every commit
  // the fixture needs.
  describe('snapshot capture failure → snapshot-capture-failed warning', () => {
    type WarnEnvelope = OkEnvelope & { warnings?: Array<{ code: string; message: string }> };

    /** The four — and only four — keys the strict, vendored boundary schema allows. */
    const BOUNDARY_KEYS = [
      'snapshot_commit_sha',
      'snapshot_error_reason',
      'snapshot_ref',
      'tree_sha',
    ];

    const FAILED_BOUNDARY = {
      snapshot_ref: null,
      tree_sha: null,
      snapshot_commit_sha: null,
      snapshot_error_reason: 'unknown',
    };

    async function breakGitAdd(): Promise<void> {
      await writeFile(path.join(repo.path, '.gitattributes'), '* filter=explode\n', 'utf8');
      execFileSync('git', ['config', 'filter.explode.clean', 'false'], { cwd: repo.path });
      execFileSync('git', ['config', 'filter.explode.required', 'true'], { cwd: repo.path });
    }

    function snapshotWarning(env: WarnEnvelope): { code: string; message: string } {
      const w = (env.warnings ?? []).find((x) => x.code === 'snapshot-capture-failed');
      expect(
        w,
        `no snapshot-capture-failed warning in ${JSON.stringify(env.warnings)}`
      ).toBeDefined();
      return w!;
    }

    /**
     * The load-bearing assertion: the warning carries git's OWN words. Matching
     * on /filter/i rather than a literal phrase keeps this stable across git
     * versions — both lines git emits here ("external filter '…' failed",
     * "clean filter '…' failed") name the filter, and neither string can be
     * produced by the CLI's own message text.
     */
    function expectCarriesGitStderr(warning: { message: string }, phase: string): void {
      expect(warning.message).toContain(`${phase} snapshot capture FAILED`);
      expect(warning.message).toContain('snapshot_error_reason: unknown');
      expect(warning.message).toContain('git said:');
      expect(warning.message).not.toContain('git reported no message');
      expect(warning.message).toMatch(/filter/i);
    }

    /**
     * The constraint the whole design bends around: nothing about the message
     * reached disk. `CheckpointSnapshotBoundary` is `.strict()` and lives in the
     * vendored `@orcaops/protocol` tarball, so a fifth key would be a parse
     * error rather than an ignored field — asserted here against the REAL schema.
     */
    function expectBoundaryUnchanged(boundary: unknown): void {
      expect(Object.keys(boundary as object).sort()).toEqual(BOUNDARY_KEYS);
      expect(boundary).toEqual(FAILED_BOUNDARY);
      expect(() => CheckpointSnapshotBoundarySchema.parse(boundary)).not.toThrow();
      expect(JSON.stringify(boundary)).not.toMatch(/filter/i);
    }

    async function eventPayloadFor<T>(artifactId: string, type: string, n: number): Promise<T> {
      const events = await readEventLog(repo.path, artifactId);
      for (const e of events.filter((x) => x.type === type)) {
        const payload = await loadEventPayload<{ n?: number }>(repo.path, artifactId, e);
        if (payload.n === n) return payload as T;
      }
      throw new Error(`no ${type} event found for n=${n}`);
    }

    it('open: the git stderr rides out on the response warnings; boundary unchanged', async () => {
      const plan = await capturePlan(['step a']);
      await breakGitAdd();

      const opened = parseOk<WarnEnvelope & { n: number; status: string }>(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
      );
      // Fail-open intact: exit 0 (parseOk) and the cp still committed. The
      // warning is the ONLY signal — before it, this was a silent success.
      expect(opened.status).toBe('open');
      expectCarriesGitStderr(snapshotWarning(opened), 'open');

      const proj = await readCheckpointProjection<OpenCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        1
      );
      // The capture genuinely failed (control against a fixture that no-ops).
      expect(proj.open_snapshot.snapshot_error_reason).toBe('unknown');
      expectBoundaryUnchanged(proj.open_snapshot);
      // …and on the event payload, which is the persisted truth the projection
      // is derived from.
      const payload = await eventPayloadFor<{ open_snapshot: unknown }>(
        plan.artifact_id,
        'checkpoint_opened',
        1
      );
      expectBoundaryUnchanged(payload.open_snapshot);
    });

    it('close: the git stderr rides out on the response warnings; boundary unchanged', async () => {
      const plan = await capturePlan(['step a']);
      // Open cleanly, do real work, THEN break capture — so only the close
      // snapshot fails and the open boundary stays a captured control.
      parseOk(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
      );
      await commitFile(repo.path, 'src/foo.ts', 'export const x = 1;\n', 'add foo');
      await breakGitAdd();

      const closed = parseOk<WarnEnvelope & { status: string }>(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1 added foo',
          files_changed: ['src/foo.ts'],
          completed_step_ids: [plan.step_ids[0]],
        })
      );
      expect(closed.status).toBe('closed');
      expectCarriesGitStderr(snapshotWarning(closed), 'close');

      const proj = await readCheckpointProjection<ClosedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        1
      );
      expect(proj.open_snapshot.tree_sha).not.toBeNull(); // only the close broke
      expectBoundaryUnchanged(proj.close_snapshot);
      // The fingerprint degraded exactly as before — this change adds a
      // response warning, it does not alter what gets written.
      expect(proj.diff_fingerprint_summary.status).toBe('skipped');
      expect(proj.diff_fingerprint_summary.error_reason).toBe('unknown');

      const payload = await eventPayloadFor<{ close_snapshot: unknown }>(
        plan.artifact_id,
        'checkpoint_closed',
        1
      );
      expectBoundaryUnchanged(payload.close_snapshot);
    });

    it('abandon: the git stderr rides out on the response warnings; boundary unchanged', async () => {
      const plan = await capturePlan(['step a']);
      parseOk(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
      );
      await breakGitAdd();

      const abandoned = parseOk<WarnEnvelope & { status: string }>(
        await abandonCp({ artifact_id: plan.artifact_id, n: 1, reason: 'rescope' })
      );
      expect(abandoned.status).toBe('abandoned');
      expectCarriesGitStderr(snapshotWarning(abandoned), 'abandon');

      const proj = await readCheckpointProjection<AbandonedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        1
      );
      expectBoundaryUnchanged(proj.abandon_snapshot);
    });

    it('healthy captures stay quiet: no warnings on open, close, or abandon', async () => {
      // Control for the surface added on open/abandon: it must not fire on the
      // ordinary path, or the signal is worthless.
      const plan = await capturePlan(['step a', 'step b']);
      const opened = parseOk<WarnEnvelope>(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
      );
      expect(opened.warnings).toBeUndefined();

      await commitFile(repo.path, 'src/ok.ts', 'export const ok = 1;\n', 'work');
      const closed = parseOk<WarnEnvelope>(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1 clean capture',
          files_changed: ['src/ok.ts'],
          completed_step_ids: [plan.step_ids[0]],
        })
      );
      expect(closed.warnings).toBeUndefined();

      parseOk(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[1]] })
      );
      const abandoned = parseOk<WarnEnvelope>(
        await abandonCp({ artifact_id: plan.artifact_id, n: 2, reason: 'rescope' })
      );
      expect(abandoned.warnings).toBeUndefined();
    });
  });

  // Cloud-auth independence: snapshots + fingerprints are captured
  // regardless of auth state — `diff_fingerprint.enabled` is the only gate (its
  // disabled path stays pinned by the baseline describe below and the
  // fingerprint-show skip tests). These reuse the suite's helpers (and its
  // DISABLE_DRAIN agent); each resets cred state explicitly.
  describe('cloud-auth independence', () => {
    async function openModifyClose(stepText = 'step a'): Promise<{
      artifactId: string;
      proj: ClosedCheckpointProjection;
    }> {
      const plan = await capturePlan([stepText]);
      parseOk(
        await openCp({ artifact_id: plan.artifact_id, declared_step_ids: [plan.step_ids[0]] })
      );
      await commitFile(repo.path, 'src/foo.ts', 'export const x = 1;\n', 'add foo');
      parseOk(
        await closeCp({
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1 added foo',
          files_changed: ['src/foo.ts'],
          completed_step_ids: [plan.step_ids[0]],
        })
      );
      const proj = await readCheckpointProjection<ClosedCheckpointProjection>(
        repo.path,
        plan.artifact_id,
        1
      );
      return { artifactId: plan.artifact_id, proj };
    }

    it('not logged in → snapshots + fingerprint captured', async () => {
      clearCloudLogin();
      const { artifactId, proj } = await openModifyClose();

      expect(proj.open_snapshot.tree_sha).not.toBeNull();
      expect(proj.open_snapshot.snapshot_ref).not.toBeNull();
      expect(proj.open_snapshot.snapshot_error_reason).toBeNull();
      expect(proj.close_snapshot.tree_sha).not.toBeNull();
      expect(proj.diff_fingerprint_summary.status).toBe('captured');
      expect(proj.diff_fingerprint_summary.error_reason).toBeNull();

      // Snapshot refs WERE minted in git despite the logged-out state.
      const refs = execFileSync(
        'git',
        ['for-each-ref', '--format=%(refname)', `refs/orcaops/snap/${artifactId}/`],
        { cwd: repo.path, encoding: 'utf8' }
      );
      expect(refs.trim()).not.toBe('');
    });

    // This suite sets ORCAOPS_DISABLE_DRAIN=1, so the stale credential is NOT
    // refreshed here — and capture proceeds anyway: auth state (fresh, stale, or
    // absent) does not gate the snapshot path. The refresh mechanism itself stays
    // proven in checkpoint-snapshot-drain.test.ts.
    it('stale login past grace, drain disabled → still captures', async () => {
      clearCloudLogin();
      seedCloudLogin({ expiresInSeconds: -(31 * 86_400) }); // expired 31 days ago, past the grace
      const { proj } = await openModifyClose();

      expect(proj.open_snapshot.tree_sha).not.toBeNull();
      expect(proj.close_snapshot.tree_sha).not.toBeNull();
      expect(proj.diff_fingerprint_summary.status).toBe('captured');
    });
  });

  // Plan-time baseline (seed) capture is gated on the SAME condition as
  // checkpoint snapshot capture: `diff_fingerprint.enabled` (cloud auth is
  // deliberately NOT part of the gate). The seed only feeds
  // empty-fence recovery, which itself only runs under that gate — so capturing
  // it when fingerprinting is disabled would write a full-worktree tree + pin a
  // lingering `refs/orcaops/baseline/<id>` ref that recovery can never consume.
  // These pin the gate at the plan boundary.
  describe('plan-time baseline (seed) capture gating', () => {
    function liveBaselineRefs(): string[] {
      return execFileSync(
        'git',
        ['for-each-ref', '--format=%(refname)', 'refs/orcaops/baseline/'],
        { cwd: repo.path, encoding: 'utf8' }
      )
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    async function readArtifactJson(
      artifactId: string
    ): Promise<{ baseline_seed_tree_sha: string | null; superseded_artifact_id: string | null }> {
      return JSON.parse(
        await readFile(
          path.join(repo.path, '.orcaops', 'artifacts', artifactId, 'artifact.json'),
          'utf8'
        )
      ) as { baseline_seed_tree_sha: string | null; superseded_artifact_id: string | null };
    }

    it('fingerprint enabled (control) → baseline ref pinned + non-null seed', async () => {
      // The default config enables fingerprinting, so the gate is OPEN and the
      // plan-time baseline IS captured — no login required. Proves the disabled
      // case below asserts a real behavior change, not an always-off path.
      const plan = await capturePlan(['step a']);
      expect(liveBaselineRefs()).toContain(baselineRefName(plan.artifact_id));
      const aj = await readArtifactJson(plan.artifact_id);
      expect(aj.baseline_seed_tree_sha).toMatch(/^[0-9a-f]{40,64}$/);
    });

    it('not logged in → baseline ref still pinned + non-null seed', async () => {
      clearCloudLogin();
      const plan = await capturePlan(['step a']);
      // Auth does not gate the plan-time seed: the baseline ref is
      // minted and the seed recorded exactly as in the enabled control above.
      expect(liveBaselineRefs()).toContain(baselineRefName(plan.artifact_id));
      const aj = await readArtifactJson(plan.artifact_id);
      expect(aj.baseline_seed_tree_sha).toMatch(/^[0-9a-f]{40,64}$/);
      expect(aj.superseded_artifact_id).toBeNull();
    });

    it('diff_fingerprint disabled → NO baseline ref pinned + seed null', async () => {
      // Fingerprinting disabled in config — the one remaining gate (the privacy
      // opt-out). resolveConfig deep-merges with defaults so a partial
      // override suffices; capture re-reads config from disk.
      await agent.runRaw(['init', '--scope', 'project', '--json', '--no-llm']);
      const configPath = path.join(repo.path, '.orcaops', 'config.json');
      const existing = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      await writeFile(
        configPath,
        JSON.stringify({ ...existing, diff_fingerprint: { enabled: false } }, null, 2),
        'utf8'
      );
      const r = await agent.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'baseline gating — fingerprint disabled',
            label: 'baseline-gate-disabled',
            plan_steps: [{ text: 'step a', label: 's1' }],
            touched_scope: [],
          })
        ),
      ]);
      const ok = parseOk<OkEnvelope & { artifact_id: string }>(r);
      expect(liveBaselineRefs()).toEqual([]);
      const aj = await readArtifactJson(ok.artifact_id);
      expect(aj.baseline_seed_tree_sha).toBeNull();
    });
  });
});
