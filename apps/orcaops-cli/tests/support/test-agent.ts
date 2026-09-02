import { DEFAULT_CLOUD_BASE_URL } from '@orcaops/core';
import { InProcessAgent } from '@orcaops/test-harness';

import { buildProgram } from '../../src/cli/program.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';

/**
 * Construct an `InProcessAgent` wired to this CLI's `buildProgram` and
 * `runInInvocationContext`. Shared by every integration test so the
 * harness's required dependencies (which can't live inside
 * `@orcaops/test-harness` without inverting the workspace dep
 * direction) are declared in exactly one place.
 *
 * Pass `cwd` (typically the path returned by `createTempRepo`), and
 * optionally `env` (test-specific overrides like `CLAUDE_SESSION_ID`,
 * `XDG_STATE_HOME`) and a `timeoutMs` for long-running flows.
 */
export function makeAgent(opts: {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  cloudBaseUrl?: string;
}): InProcessAgent {
  const cloudBaseUrl = opts.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL;
  const buildInjectedProgram = () => buildProgram({ cloudBaseUrl });
  return new InProcessAgent({
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    buildProgram: buildInjectedProgram,
    runInInvocationContext: (context, fn) =>
      runInInvocationContext({ ...context, cloudBaseUrl }, fn),
  });
}
