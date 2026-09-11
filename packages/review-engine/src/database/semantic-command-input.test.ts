import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import { SEMANTIC_ANCHOR_PROFILE, SEMANTIC_ANCHOR_PROFILE_V1 } from '../semanticAnchors.js';
import { parseSemanticCommand, readSemanticCommandSubmission } from './semantic-command-input.js';

const reviewId = uuidv7();
const args = () => [
  'review',
  'semantic-anchor-submit',
  '--review',
  reviewId,
  '--run',
  'retained-account-run',
  '--profile',
  SEMANTIC_ANCHOR_PROFILE,
  '--input',
  '-',
];
const parse = (more: string[] = []) => parseSemanticCommand([...args(), ...more], {}, '/original');
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('semantic command request admission', () => {
  it('retains exact original identities and copies invocation environment and arguments', () => {
    const argv = [
      ...args(),
      '--root',
      'checkout',
      '--project',
      uuidv7(),
      '--operation-id',
      uuidv7(),
      '--generation',
      uuidv7(),
      '--json',
    ];
    const env = { ORCAOPS_ROOT: 'other' };
    const parsed = parseSemanticCommand(argv, env, '/original');
    argv[5] = 'changed';
    env.ORCAOPS_ROOT = '/changed';
    expect(parsed).toMatchObject({
      reviewId,
      runId: 'retained-account-run',
      cwd: '/original/checkout',
      env: { ORCAOPS_ROOT: 'other' },
      json: true,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.env)).toBe(true);
  });
  it('resolves the environment override and input against the same original cwd', () => {
    const argv = args();
    argv[argv.length - 1] = 'payload.json';
    expect(parseSemanticCommand(argv, { ORCAOPS_ROOT: 'checkout' }, '/original')).toMatchObject({
      cwd: '/original/checkout',
      input: '/original/payload.json',
    });
  });
  it('accepts explicit branch selection and equals-form original run identities', () => {
    const argv = args();
    argv.splice(2, 4, '--branch=topic', '--run=--original-run');
    expect(parseSemanticCommand(argv, {}, '/original')).toMatchObject({
      branch: 'topic',
      runId: '--original-run',
    });
  });
  it.each([
    ['--run', 'other'],
    ['--json', '--json'],
    ['--profile=other'],
    ['--unknown'],
    ['--root'],
    ['--generation', 'not-a-uuid'],
    ['--operation-id', 'not-a-uuid'],
  ])('rejects duplicate, unknown, missing or invalid options %j', (...more) => {
    expect(() => parse(more)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
  it('rejects absent selectors, empty run identities and sparse arguments', () => {
    const absent = args();
    absent.splice(2, 2);
    expect(() => parseSemanticCommand(absent, {}, '/original')).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
    const empty = args();
    empty[5] = '';
    expect(() => parseSemanticCommand(empty, {}, '/original')).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
    const sparse = args();
    delete sparse[3];
    expect(() => parseSemanticCommand(sparse, {}, '/original')).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  });
});

describe('semantic command input transport', () => {
  it('preserves exact UTF-8 file bytes and the original profile ceiling', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'semantic-input-'));
    directories.push(dir);
    const bytes = Buffer.from(' {"associations":[]}\n');
    await writeFile(path.join(dir, 'input.json'), bytes);
    const argv = args();
    argv[argv.length - 1] = 'input.json';
    const request = parseSemanticCommand(argv, {}, dir);
    const found = await readSemanticCommandSubmission(request);
    expect(found.bytes).toEqual(bytes);
    await writeFile(
      path.join(dir, 'input.json'),
      Buffer.alloc(SEMANTIC_ANCHOR_PROFILE_V1.maximum_submission_bytes + 1, 32)
    );
    await expect(readSemanticCommandSubmission(request)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
  it('copies prepared bytes before awaiting and accepts the exact byte ceiling', async () => {
    const preparedBytes = Buffer.alloc(SEMANTIC_ANCHOR_PROFILE_V1.maximum_submission_bytes, 32);
    const promise = readSemanticCommandSubmission(parse(), { preparedBytes });
    preparedBytes.fill(0xff);
    expect((await promise).bytes).toEqual(Buffer.alloc(preparedBytes.length, 32));
  });
  it('copies stream chunks and refuses overflow without retaining a truncated submission', async () => {
    const stream = new PassThrough();
    const chunk = Buffer.from('{}');
    const promise = readSemanticCommandSubmission(parse(), { stdin: stream });
    stream.write(chunk);
    chunk.fill(32);
    stream.end();
    expect((await promise).bytes.toString()).toBe('{}');
    await expect(
      readSemanticCommandSubmission(parse(), { stdin: Readable.from([Buffer.alloc(128001)]) })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('retains original cancellation while waiting for input and removes owned listeners', async () => {
    const controller = new AbortController();
    const stream = new PassThrough();
    const options = { signal: controller.signal, stdin: stream };
    const promise = readSemanticCommandSubmission(parse(), options);
    options.signal = new AbortController().signal;
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    for (const event of ['data', 'end', 'close', 'error'])
      expect(stream.listenerCount(event)).toBe(0);
    expect(stream.destroyed).toBe(false);
    stream.destroy();
  });
  it('refuses premature stream close and unreadable files with safe input errors', async () => {
    const stream = new PassThrough();
    const promise = readSemanticCommandSubmission(parse(), { stdin: stream });
    stream.destroy();
    await expect(promise).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const request = { ...parse(), input: '/does-not-exist/submission.json' };
    await expect(readSemanticCommandSubmission(request)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
  it('rejects an already closed input stream without waiting', async () => {
    const stream = new PassThrough();
    stream.destroy();
    await expect(readSemanticCommandSubmission(parse(), { stdin: stream })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
  it('refuses malformed UTF-8 and lexical escaped secrets before any publication', async () => {
    await expect(
      readSemanticCommandSubmission(parse(), { preparedBytes: Uint8Array.of(0xff) })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const secret = 'ghp_' + 'a'.repeat(36);
    const escaped = JSON.stringify({ discarded: secret }).replace('ghp_', '\\u0067hp_');
    await expect(
      readSemanticCommandSubmission(parse(), { preparedBytes: Buffer.from(escaped) })
    ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });
  });
});
