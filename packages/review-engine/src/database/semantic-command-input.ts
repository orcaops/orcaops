import { createReadStream } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { SEMANTIC_ANCHOR_PROFILE, SEMANTIC_ANCHOR_PROFILE_V1 } from '../semanticAnchors.js';
import { cancelled, invalid, revisionId, scanMetadata, text, validate } from './request.js';
import { prepareDatabaseSemanticSubmission } from './semantic-submission.js';

const fields = {
  '--root': 'root',
  '--project': 'projectId',
  '--review': 'reviewId',
  '--branch': 'branch',
  '--run': 'runId',
  '--profile': 'profile',
  '--input': 'input',
  '--generation': 'generationId',
  '--operation-id': 'operationId',
} as const;
const schema = z
  .strictObject({
    root: text.optional(),
    projectId: revisionId.optional(),
    reviewId: revisionId.optional(),
    branch: text.refine((value) => Boolean(value.trim()) && !/[\0\r\n]/u.test(value)).optional(),
    runId: text,
    profile: z.literal(SEMANTIC_ANCHOR_PROFILE),
    input: text,
    generationId: z.uuid().optional(),
    operationId: revisionId.optional(),
    json: z.boolean(),
  })
  .refine((value) => value.reviewId !== undefined || value.branch !== undefined);

export function parseSemanticCommand(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string) {
  if (!Array.isArray(argv) || Array.from(argv).some((arg) => typeof arg !== 'string'))
    invalid('Provide complete semantic submission arguments');
  const args = [...argv];
  if (args.shift() !== 'review' || args.shift() !== 'semantic-anchor-submit')
    invalid('Use the semantic-anchor-submit review command');
  const values: Record<string, unknown> = { json: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const equal = arg.indexOf('=');
    const flag = equal === -1 ? arg : arg.slice(0, equal);
    if (seen.has(flag)) invalid('Provide each semantic submission option only once');
    seen.add(flag);
    if (flag === '--json' && equal === -1) {
      values.json = true;
      continue;
    }
    if (!Object.hasOwn(fields, flag)) invalid('Use only supported semantic submission options');
    const value = equal === -1 ? args[++i] : arg.slice(equal + 1);
    if (value === undefined || (equal === -1 && value.startsWith('--')))
      invalid(
        'Provide a value for each semantic submission option; use --flag=value for a leading --'
      );
    values[fields[flag as keyof typeof fields]] = value;
  }
  const request = validate(schema, values);
  scanMetadata(request, []);
  const invocationCwd = path.resolve(cwd);
  return Object.freeze({
    ...request,
    input: request.input === '-' ? '-' : path.resolve(invocationCwd, request.input),
    cwd: path.resolve(invocationCwd, request.root ?? env.ORCAOPS_ROOT ?? '.'),
    env: Object.freeze({ ...env }),
  });
}
export type SemanticCommandInput = ReturnType<typeof parseSemanticCommand>;

function inputFailure(cause?: unknown) {
  return new ProjectDatabaseError(
    'INVALID_INPUT',
    'Semantic submission input could not be read completely; provide a readable UTF-8 file or stream',
    { cause }
  );
}

function readBoundedStream(stream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<Buffer> {
  cancelled(signal);
  if (stream.readable === false) return Promise.reject(inputFailure());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let count = 0;
    let settled = false;
    const cleanup = () => {
      stream.pause();
      stream.removeListener('data', data);
      stream.removeListener('end', end);
      stream.removeListener('error', error);
      stream.removeListener('close', close);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause);
    };
    const data = (chunk: unknown) => {
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
        fail(inputFailure());
        return;
      }
      count += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (count > SEMANTIC_ANCHOR_PROFILE_V1.maximum_submission_bytes) {
        fail(
          new ProjectDatabaseError(
            'INVALID_INPUT',
            'The semantic submission exceeds its retained profile byte ceiling'
          )
        );
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const end = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const error = (cause: unknown) => fail(inputFailure(cause));
    const close = () => fail(inputFailure());
    const abort = () => {
      try {
        cancelled(signal);
      } catch (cause) {
        fail(cause);
      }
    };
    stream.on('data', data);
    stream.once('end', end);
    stream.once('error', error);
    stream.once('close', close);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function readSemanticCommandSubmission(
  input: SemanticCommandInput,
  options: { signal?: AbortSignal; stdin?: NodeJS.ReadableStream; preparedBytes?: Uint8Array } = {}
) {
  const signal = options.signal;
  const stdin = options.stdin ?? process.stdin;
  const filename = input.input;
  if (
    options.preparedBytes !== undefined &&
    options.preparedBytes.byteLength > SEMANTIC_ANCHOR_PROFILE_V1.maximum_submission_bytes
  )
    invalid('The semantic submission exceeds its retained profile byte ceiling');
  const prepared =
    options.preparedBytes === undefined ? undefined : Buffer.from(options.preparedBytes);
  cancelled(signal);
  const file = prepared === undefined && filename !== '-' ? createReadStream(filename) : undefined;
  let bytes: Buffer;
  try {
    bytes = prepared ?? (await readBoundedStream(file ?? stdin, signal));
  } finally {
    file?.destroy();
  }
  cancelled(signal);
  return prepareDatabaseSemanticSubmission({
    bytes,
    maximumBytes: SEMANTIC_ANCHOR_PROFILE_V1.maximum_submission_bytes,
    secretAllow: [],
  });
}
