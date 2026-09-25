import type { PreparedInputCallOptions, PreparedInputCallResult } from '@orcaops/llm';

import type { Proposer } from './harness.js';

/**
 * The call this proposer makes. It is injected rather than imported, so the
 * module carries no dependency on the provider adapters and a test decides
 * which binary the call reaches.
 */
export type PreparedInputCall = (
  options: PreparedInputCallOptions
) => Promise<PreparedInputCallResult>;

export interface PreparedInputProposerOptions {
  call: PreparedInputCall;
  maxInputBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  scratchParentDir?: string;
}

/**
 * A proposer over one prepared-input, no-tool call. The provider is given the
 * request exactly as the request builder composed it and nothing else: no
 * tools, no repository, and an answer bounded in bytes and in time. Whatever
 * comes back is still validated, so a provider that ignores the schema or
 * answers something else publishes nothing.
 */
export function preparedInputProposer(options: PreparedInputProposerOptions): Proposer {
  return async (request) => {
    const result = await options.call({
      ...request.parts,
      maxInputBytes: options.maxInputBytes,
      maxOutputBytes: options.maxOutputBytes,
      timeoutMs: options.timeoutMs,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      ...(options.scratchParentDir === undefined
        ? {}
        : { scratchParentDir: options.scratchParentDir }),
    });
    return result.status === 'completed'
      ? { status: 'answered', body: result.body }
      : { status: 'failed', code: result.code, message: result.message };
  };
}
