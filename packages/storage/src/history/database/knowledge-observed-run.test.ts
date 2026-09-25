// A real subprocess, against real files, whose digests the test takes from what the process says
// it read. Nothing else substantiates a claim about consumed inputs: an in-process fake would
// prove only that this module can copy a digest from one field to another.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import { publishProjectObservedRun, readProjectObservation } from './knowledge-observations.js';
import { runnerEstablished, runObservedProcess } from './knowledge-observed-run.js';
import { authorityStore } from '../../../tests/knowledge-authority-store.js';
import { AGENT, discardKnowledgeStores, read } from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';

const READER = fileURLToPath(new URL('../../../tests/observed-input-reader.mjs', import.meta.url));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((at) => rm(at, { recursive: true, force: true })));
  await discardKnowledgeStores();
});

async function retainedInputs(contents: Readonly<Record<string, string>>) {
  const at = await mkdtemp(path.join(tmpdir(), 'observed-run-'));
  directories.push(at);
  const inputs = [];
  for (const [name, text] of Object.entries(contents)) {
    await writeFile(path.join(at, name), text, 'utf8');
    inputs.push({ name, path: path.join(at, name) });
  }
  return { at, inputs };
}

const run = (
  at: string,
  inputs: { name: string; path: string }[],
  env: Record<string, string> = {}
) =>
  runObservedProcess({
    runner: 'orcaops-observed-run',
    argv: [process.execPath, READER],
    cwd: at,
    env: { PATH: process.env.PATH ?? '', ...env },
    inputs,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });

const digestsRead = (stdout: string) =>
  (JSON.parse(stdout) as { name: string; sha256: string }[]).map(
    (entry) => `${entry.name}@sha256:${entry.sha256}`
  );

it('names the inputs a real process actually read, and rests a snapshot-bound basis on them', async () => {
  const { at, inputs } = await retainedInputs({
    'upload.ts': 'export const upload = () => retry(3);\n',
    'retry.ts': 'export const retry = (n: number) => n;\n',
  });
  const observed = await run(at, inputs);
  expect(observed.result.exit_code).toBe(0);
  expect(observed.observation.execution).toMatchObject({
    kind: 'runner_established',
    runner: 'orcaops-observed-run',
  });
  expect(observed.observation.input_basis).toBe('snapshot_bound');
  expect(observed.observation.outcome).toBe('passed');
  // What the process hashed out of the bytes it opened is what the observation names.
  const consumed = observed.observation.execution as { consumed_inputs: { identity: string }[] };
  expect(consumed.consumed_inputs.map((input) => input.identity).sort()).toEqual(
    digestsRead(observed.result.stdout).sort()
  );

  const { handle, sourceId } = await authorityStore();
  const observationId = uuidv7();
  await publishProjectObservedRun(handle, {
    operationId: uuidv7(),
    observation: {
      observation_id: observationId,
      source_id: sourceId,
      method: { name: 'observed-input-reader', configuration_sha256: null },
    },
    observedBy: AGENT,
    run: observed,
    secretAllow: [],
  });
  const row = read(handle, (view) => readProjectObservation(view, observationId))!;
  expect(row.inputBasis).toBe('snapshot_bound');
  expect(row.consumedInputs!.map((input) => input.identity).sort()).toEqual(
    digestsRead(observed.result.stdout).sort()
  );
});

it('records a failing exit code as a failure of the run, not of the basis', async () => {
  const { at, inputs } = await retainedInputs({ 'upload.ts': 'export const upload = () => 1;\n' });
  const observed = await run(at, inputs, { OBSERVED_RUN_EXIT: '3' });
  expect(observed.result.exit_code).toBe(3);
  expect(observed.observation.outcome).toBe('failed');
  expect(observed.observation.input_basis).toBe('snapshot_bound');
});

it('hands over a copy, so a change to the original cannot reach the process or the record', async () => {
  const v1 = 'export const retries = 1;\n';
  const v2 = 'export const retries = 99;\n';
  const { at, inputs } = await retainedInputs({ 'upload.ts': v1 });
  const started = path.join(at, 'started');
  const read = path.join(at, 'read');
  const running = run(at, inputs, {
    OBSERVED_RUN_ANNOUNCE: started,
    OBSERVED_RUN_WAIT_FOR: path.join(at, 'go'),
    OBSERVED_RUN_READ: read,
    OBSERVED_RUN_WAIT_TO_EXIT: path.join(at, 'exit'),
  });
  // The window a runner that handed over originals would leave open: another writer changes the
  // file, the process reads, and the change is undone before the run ends, so equal before and
  // after digests would name bytes nothing read.
  while (!existsSync(started)) await delay(5);
  await writeFile(inputs[0]!.path, v2, 'utf8');
  await writeFile(path.join(at, 'go'), '', 'utf8');
  while (!existsSync(read)) await delay(5);
  await writeFile(inputs[0]!.path, v1, 'utf8');
  await writeFile(path.join(at, 'exit'), '', 'utf8');
  const observed = await running;

  const v1Digest = createHash('sha256').update(v1).digest('hex');
  expect(digestsRead(observed.result.stdout)).toEqual([`upload.ts@sha256:${v1Digest}`]);
  expect(observed.observation.known_inputs).toEqual([
    { kind: 'file', identity: `upload.ts@sha256:${v1Digest}` },
  ]);
  expect(observed.observation.input_basis).toBe('snapshot_bound');
  expect(observed.observation.limits).toEqual([]);
});

it('drops the basis for an input it cannot identify, and says which and why', async () => {
  const { at, inputs } = await retainedInputs({ 'upload.ts': 'export const upload = () => 1;\n' });
  const tree = path.join(at, 'sources');
  await mkdir(tree);
  const observed = await run(at, [...inputs, { name: 'sources', path: tree }]);
  expect(observed.observation.input_basis).toBe('partial');
  expect(observed.observation.limits).toEqual([
    'sources: it is not a regular file, so it was handed over in place and not identified',
  ]);
  expect(observed.observation.known_inputs).toContainEqual({
    kind: 'file',
    identity: 'sources@unidentified',
  });
});

it('drops the basis when the process rewrites or removes the copy it was handed', async () => {
  for (const change of ['OBSERVED_RUN_REWRITE', 'OBSERVED_RUN_REMOVE']) {
    const { at, inputs } = await retainedInputs({
      'upload.ts': 'export const upload = () => 1;\n',
    });
    const observed = await run(at, inputs, { [change]: '1' });
    expect(observed.observation.input_basis, change).toBe('partial');
    expect(observed.observation.limits, change).toEqual([
      'upload.ts was rewritten by the process it was handed to',
    ]);
    // The run still reports what it was: a result is not lost over what became of an input.
    expect(observed.result.exit_code, change).toBe(0);
  }
});

it('marks only what it returned as runner established', async () => {
  const { at, inputs } = await retainedInputs({ 'upload.ts': 'export const upload = () => 1;\n' });
  const observed = await run(at, inputs);
  expect(runnerEstablished(observed)).toBe(true);
  // Every field copied, and still not a run: membership is the proof, not the shape.
  expect(runnerEstablished({ ...observed })).toBe(false);
});

it('refuses a runner-established execution with no identified input to name', async () => {
  const { at } = await retainedInputs({});
  await expect(run(at, [])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('refuses to hand over an input it cannot find', async () => {
  const { at } = await retainedInputs({});
  await expect(
    run(at, [{ name: 'absent.ts', path: path.join(at, 'absent.ts') }])
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
