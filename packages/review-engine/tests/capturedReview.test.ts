import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import { capturedReviewFixture } from './capturedReviewFixture.js';
import {
  applyDatabaseReviewWorkflow,
  readDatabaseReviewWorkflowEvents,
} from '../src/database/workflow-command.js';
import { runJournal } from '../src/journal.js';
import { runReview } from '../src/run.js';

it('publishes a floor whose outline threads carry the captured checkpoints', async () => {
  const f = await capturedReviewFixture();
  const published = await f.publishFloor();
  expect(published.floor_outcome).toBe('published');
  const floor = published.floor;

  expect(floor.scope.artifact_ids.slice().sort()).toEqual(
    f.artifacts.map((artifact) => artifact.artifactId).sort()
  );
  expect(floor.outline.threads.length).toBe(f.artifacts.length);
  for (const artifact of f.artifacts) {
    const thread = floor.outline.threads.find((entry) =>
      entry.checkpoints.every(
        (checkpoint) => checkpoint.checkpoint.artifact === artifact.artifactId
      )
    );
    expect(thread, `no outline thread for ${artifact.label}`).toBeDefined();
    expect(thread!.checkpoints.map((checkpoint) => checkpoint.checkpoint.cp)).toEqual(
      artifact.checkpoints.map((checkpoint) => checkpoint.n)
    );
  }
  // The diff is real, so the floor's coverage has reviewable rows to attribute.
  expect(floor.coverage.summary.reviewable_rows).toBeGreaterThan(0);
  expect(floor.coverage.summary.matched_rows).toBeGreaterThan(0);
}, 120_000);

it('appends a workflow event against a published floor thread', async () => {
  const f = await capturedReviewFixture();
  const published = await f.publishFloor();
  const threadKey = published.floor.outline.threads[0]!.threadKey;

  const applied = await applyDatabaseReviewWorkflow({
    branch: f.branch,
    cwd: f.gitRoot,
    dataRoot: f.dataRoot,
    projectId: f.projectId,
    operationId: uuidv7(),
    events: [{ type: 'section', ts: '2026-06-02T00:00:00.000Z', threadKey, action: 'VISIT' }],
    secretAllow: [],
  });
  expect(applied.value.revisions).toHaveLength(1);

  const retained = await readDatabaseReviewWorkflowEvents({
    branch: f.branch,
    cwd: f.gitRoot,
    dataRoot: f.dataRoot,
    projectId: f.projectId,
  });
  expect(retained.events).toEqual([
    { type: 'section', ts: '2026-06-02T00:00:00.000Z', threadKey, action: 'VISIT' },
  ]);
}, 120_000);

it('replays the appended disposition through the public journal verb', async () => {
  const f = await capturedReviewFixture();
  const published = await f.publishFloor();
  const threadKey = published.floor.outline.threads[0]!.threadKey;
  vi.stubEnv('ORCAOPS_DATA_DIR', f.dataRoot);
  const out: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  try {
    const code = await runJournal(
      {
        cmd: 'review',
        sub: 'journal',
        branch: f.branch,
        json: true,
        addEvent: JSON.stringify({
          type: 'section',
          ts: '2026-06-02T00:00:00.000Z',
          threadKey,
          action: 'VISIT',
        }),
      },
      f.gitRoot
    );
    expect(code).toBe(0);
  } finally {
    stdout.mockRestore();
    vi.unstubAllEnvs();
  }
  const ledger = JSON.parse(out.join('')) as {
    sections: { threadKey: string; state: string }[];
  };
  expect(ledger.sections).toEqual([
    { threadKey, state: 'visited', reason: null, ts: '2026-06-02T00:00:00.000Z' },
  ]);
}, 120_000);

it('carries the sealed Story generation into the journal ledger', async () => {
  const f = await capturedReviewFixture();
  await f.publishFloor();
  const runtime = await f.runtimeDescriptor();
  vi.stubEnv('ORCAOPS_DATA_DIR', f.dataRoot);
  const out: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const run = (argv: string[]) =>
    runReview(
      ['review', ...argv, '--branch', f.branch, '--root', f.gitRoot, '--json'],
      process.env,
      undefined,
      runtime
    );
  const lastJson = () => {
    for (let i = out.length - 1; i >= 0; i -= 1)
      if (out[i]!.trimStart().startsWith('{'))
        return JSON.parse(out[i]!) as Record<string, unknown>;
    throw new Error(`no JSON output; stderr: ${stderr.join('')}`);
  };
  const payload = async (name: string, value: unknown) => {
    const file = path.join(f.root, name);
    await writeFile(file, JSON.stringify(value));
    return file;
  };
  try {
    expect(await run(['routine-start'])).toBe(0);
    const runId = lastJson().run_id as string;
    const submit = (lane: string, input: string) =>
      run([
        'routine-submit',
        '--run',
        runId,
        '--lane',
        lane,
        '--isolation',
        'sequential',
        '--input',
        input,
      ]);
    expect(
      await submit(
        'forensic',
        await payload('forensic.json', {
          findings: [
            {
              claim: 'The limiter has no shared clock across processes.',
              file: 'src/limiter.ts',
              related_files: [],
              severity: 'CAUTION',
              confidence: 'HIGH',
            },
          ],
          questions: [],
        })
      )
    ).toBe(0);
    const served = await readFile(
      path.join(f.gitRoot, (lastJson().account as Record<string, unknown>).payload_path as string),
      'utf8'
    );
    const checkpoints = [...served.matchAll(/^#### (k\d+) ·/gm)].map((match) => match[1]!);
    const citation = /\[(c\d+)\]/.exec(served)![1]!;
    expect(
      await submit(
        'account',
        await payload('account.json', {
          schema_version: 1,
          overview: { text: 'One coherent change, captured end to end.', citations: [citation] },
          acts: [
            {
              title: 'The change',
              interpretation: 'One causal arc.',
              parts: checkpoints.map((alias, index) => ({
                title: `Part ${index + 1}`,
                checkpoints: [alias],
                interpretation: `Part ${index + 1} advances the change.`,
                citations: [citation],
              })),
            },
          ],
          questions: [],
        })
      )
    ).toBe(0);
    const sealed = lastJson();
    expect(sealed.outcome).toBe('FULL');
    const generation = (sealed.current_story as { generation: string }).generation;
    expect(generation).toEqual(expect.any(String));

    // The journal's ledger generation now carries the selected Story, so a
    // STORY-basis transition can name the lens the reviewer actually read.
    expect(await run(['journal'])).toBe(0);
    const ledger = JSON.parse(out[out.length - 1]!) as { ledger_generation: string };
    const accepted = await run([
      'journal',
      '--add',
      JSON.stringify({
        type: 'review_lifecycle',
        ts: '2026-06-12T00:00:00.000Z',
        action: 'PARTIAL',
        review_basis: 'STORY',
        floor_input_hash: (await f.publishFloor()).floor.input_hash,
        story_generation: generation,
        ledger_generation: ledger.ledger_generation,
        actor: 'REVIEWER',
        source: 'WATCH',
        remaining_work: 'the account lane still needs a second pass',
      }),
    ]);
    expect(accepted, stderr.join('')).toBe(0);
    expect(
      (JSON.parse(out[out.length - 1]!) as { lifecycle: { state: string } }).lifecycle.state
    ).toBe('PARTIAL');
  } finally {
    stdout.mockRestore();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
}, 300_000);

it('reads the review pane from the store: floor with threads, diff, and an absent Story', async () => {
  const f = await capturedReviewFixture();
  const published = await f.publishFloor();
  vi.stubEnv('ORCAOPS_DATA_DIR', f.dataRoot);
  const out: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  try {
    const code = await runReview(
      ['review', 'pane', '--branch', f.branch, '--root', f.gitRoot, '--json'],
      { ...process.env, ORCAOPS_DATA_DIR: f.dataRoot },
      f.gitRoot
    );
    expect(code).toBe(0);
  } finally {
    stdout.mockRestore();
    vi.unstubAllEnvs();
  }
  const pane = JSON.parse(out.join('')) as {
    ok: boolean;
    floor: { input_hash: string; outline: { threads: unknown[] } };
    diff: string;
    routineStory: { status: string; anchors: { status: string } };
    generations: { floor: string | null; comments: string | null; workflow: string | null };
  };
  expect(pane.ok).toBe(true);
  // The pane is the retained floor, not a rebuilt one.
  expect(pane.floor.input_hash).toBe(published.floor.input_hash);
  expect(pane.floor.outline.threads.length).toBeGreaterThan(0);
  expect(pane.diff.length).toBeGreaterThan(0);
  // No run has sealed a Story, so the overlay is absent, not floorless.
  expect(pane.routineStory.status).toBe('absent');
  expect(pane.routineStory.anchors.status).toBe('absent');
  expect(pane.generations.floor).toBe(published.publication_id);
}, 120_000);

it('reports a branch with no published review as REVIEW_NOT_FOUND rather than an empty pane', async () => {
  const f = await capturedReviewFixture();
  vi.stubEnv('ORCAOPS_DATA_DIR', f.dataRoot);
  const out: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  let code: number;
  try {
    code = await runReview(
      ['review', 'pane', '--branch', 'a-branch-with-no-review', '--root', f.gitRoot, '--json'],
      { ...process.env, ORCAOPS_DATA_DIR: f.dataRoot },
      f.gitRoot
    );
  } finally {
    stdout.mockRestore();
    vi.unstubAllEnvs();
  }
  expect(code).toBe(1);
  expect(JSON.parse(out.join(''))).toMatchObject({ ok: false });
}, 120_000);
