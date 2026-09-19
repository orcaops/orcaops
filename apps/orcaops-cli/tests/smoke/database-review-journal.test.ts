import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { fixture, git, inventory } from '../helpers/database-history.js';
import { createReview } from '../helpers/database-review.js';

const execute = promisify(execFile);

it('replays the canonical journal identically through the CLI and the one-shot Node sidecar', async () => {
  const f = await fixture();
  await createReview(f, 'main');
  const before = await inventory(f.temporary);
  const args = ['review', 'journal', '--branch', 'main', '--json'];
  const options = {
    cwd: f.main,
    env: {
      ...process.env,
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      NODE_DISABLE_COMPILE_CACHE: '1',
    },
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  };
  const cli = await execute(
    process.execPath,
    [fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)), ...args],
    options
  );
  const sidecar = await execute(
    process.execPath,
    [
      fileURLToPath(new URL('../../../../packages/watch-data/dist/sidecar.js', import.meta.url)),
      ...args,
    ],
    options
  );
  const ledger = JSON.parse(cli.stdout) as Record<string, unknown>;
  expect(ledger).toMatchObject({ sections: [], findings: [], coverage: [], prompts: [] });
  expect(typeof ledger.ledger_generation).toBe('string');
  // The retired archive mirror was the only producer of a warnings channel.
  expect(ledger).not.toHaveProperty('warnings');
  expect(JSON.parse(sidecar.stdout)).toEqual(ledger);
  expect(await inventory(f.temporary)).toEqual(before);
});

it('dispatches review pane identically through the CLI and the one-shot Node sidecar', async () => {
  const f = await fixture();
  await createReview(f, 'main');
  const before = await inventory(f.temporary);
  // The review has no published floor, so the pane is not yet available; both
  // compiled entry points must reach the verb and agree on the envelope.
  const args = ['review', 'pane', '--branch', 'main', '--json'];
  const options = {
    cwd: f.main,
    env: {
      ...process.env,
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      NODE_DISABLE_COMPILE_CACHE: '1',
    },
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  };
  const cli = await execute(
    process.execPath,
    [fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)), ...args],
    options
  ).catch((error: { stdout: string }) => error);
  const sidecar = await execute(
    process.execPath,
    [
      fileURLToPath(new URL('../../../../packages/watch-data/dist/sidecar.js', import.meta.url)),
      ...args,
    ],
    options
  ).catch((error: { stdout: string }) => error);
  expect(JSON.parse(cli.stdout)).toMatchObject({ ok: false, code: 'REVIEW_NOT_FOUND' });
  expect(JSON.parse(sidecar.stdout)).toEqual(JSON.parse(cli.stdout));
  expect(await inventory(f.temporary)).toEqual(before);
});

it.each(['absent', 'floorless'])(
  'publishes and reads a review through the compiled sidecar from an %s review',
  async (state) => {
    const f = await fixture();
    // The sidecar snapshots the worktree; Git can reject '.' when it is empty.
    await writeFile(path.join(f.main, 'README.md'), 'Review fixture\n');
    await git(f.main, ['add', 'README.md']);
    await git(f.main, ['commit', '-qm', 'Add review content']);
    const existingReviewId = state === 'floorless' ? await createReview(f, 'main') : null;
    const sidecarPath = fileURLToPath(
      new URL('../../../../packages/watch-data/dist/sidecar.js', import.meta.url)
    );
    const options = {
      cwd: f.main,
      env: {
        ...process.env,
        ORCAOPS_ROOT: f.main,
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '1',
        NODE_DISABLE_COMPILE_CACHE: '1',
      },
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    };
    const run = (args: string[]) =>
      execute(process.execPath, [sidecarPath, 'review', ...args, '--branch', 'main'], options);
    const before = await run(['pane', '--json']).catch((error: { stdout: string }) => error);
    expect(JSON.parse(before.stdout)).toMatchObject({ ok: false, code: 'REVIEW_NOT_FOUND' });
    const produced = await run(['data']);
    expect(produced.stdout).toMatch(/^floor: main · 0 artifact\(s\)/u);
    expect(produced.stderr).toBe('');
    const read = async () =>
      JSON.parse((await run(['pane', '--json'])).stdout) as {
        ok: boolean;
        reviewId: string;
        floor: { scope: { branch: string; artifact_ids: string[] }; input_hash: string };
        generations: { floor: string };
      };
    const pane = await read();
    expect(pane).toMatchObject({
      ok: true,
      floor: { scope: { branch: 'main', artifact_ids: [] } },
    });
    if (existingReviewId !== null) expect(pane.reviewId).toBe(existingReviewId);
    expect(
      f.writer.read((view) =>
        view.get(
          'SELECT floor_publication_id, floor_version FROM review_selections WHERE review_id = ?',
          pane.reviewId
        )
      ).value
    ).toEqual({
      floor_publication_id: pane.generations.floor,
      floor_version: 1,
    });
    const retained = await inventory(f.temporary);
    expect(await read()).toEqual(pane);
    expect(await inventory(f.temporary)).toEqual(retained);
    const refreshed = await run(['data']);
    expect(refreshed.stdout).toBe(produced.stdout);
    expect(await read()).toEqual(pane);
    expect(await inventory(f.temporary)).toEqual(retained);
  }
);
