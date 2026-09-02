import { action, type Operation } from 'effection';
import { execa } from 'execa';

import { runBoundedSubprocess } from '@orcaops/evaluator-protocol/subprocess';

const PROBE_TIMEOUT_MS = 1500;
const DEFAULT_PROVIDER_PROBE_TIMEOUT_MS = 5000;
const PROVIDER_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
export type LlmProvider = 'claude' | 'codex';
export type ProviderProbeState = 'present' | 'absent' | 'unverified';
export type ProviderProbeSnapshot = Readonly<Record<LlmProvider, ProviderProbeState>>;

export interface ProviderProbeOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

export function providerBinPath(provider: LlmProvider, env?: NodeJS.ProcessEnv): string {
  const effectiveEnv = env ?? process.env;
  return provider === 'claude'
    ? (effectiveEnv.ORCAOPS_CLAUDE_PATH ?? 'claude')
    : (effectiveEnv.ORCAOPS_CODEX_PATH ?? 'codex');
}

/**
 * Returns true if the named binary responds to `<bin> --version` within
 * the probe timeout. Kept as the narrow boolean utility; provider selection
 * uses `probeProviderAvailability` so an inconclusive probe is not reported
 * as absence.
 *
 * Pass `env` to override the spawn environment (e.g. for tests that
 * sanitize `PATH`). Omitted `env` defaults to `process.env` for
 * production callers.
 */
export function commandExists(bin: string, env?: NodeJS.ProcessEnv): Operation<boolean> {
  return action<boolean>(function (resolve) {
    let settled = false;
    const proc = execa(bin, ['--version'], {
      reject: false,
      timeout: PROBE_TIMEOUT_MS,
      env: env ?? process.env,
      // `extendEnv: false` prevents execa from re-merging process.env on
      // top of the supplied `env`. Callers already merge process.env into
      // their `env` upstream (the InProcessAgent does so when constructing
      // its per-call env); without this opt-out, execa's default merge
      // would restore the parent process's PATH, defeating test-side PATH
      // sanitization.
      extendEnv: false,
    });

    proc.on('error', () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve(code === 0);
    });

    return () => {
      if (!proc.killed) {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* may already have exited */
        }
      }
    };
  });
}

/**
 * Auto-detection preference order. Shared by the selector and truthful
 * reporting surfaces; a second hardcoded ordering would drift silently.
 */
export const LLM_TOOL_PREFERENCE = ['claude', 'codex'] as const;

export type DetectableLlmTool = (typeof LLM_TOOL_PREFERENCE)[number];

/**
 * Probe the local environment for an LLM CLI tool, in preference order.
 * Returns the first confirmed-present tool, otherwise the first tool whose
 * probe was inconclusive, or null when every provider is confirmed absent.
 *
 * Pass `env` to override the spawn environment (e.g. PATH sanitization in
 * tests). Omitted `env` inherits `process.env`.
 */
export function detectAvailableTool(env?: NodeJS.ProcessEnv): Operation<DetectableLlmTool | null> {
  return runDetection(env);
}

function* runDetection(env?: NodeJS.ProcessEnv): Operation<DetectableLlmTool | null> {
  const snapshot = yield* probeProviderAvailability({ env });
  return selectDefaultProvider('auto', snapshot);
}

export function probeProviderAvailability(
  options: ProviderProbeOptions = {}
): Operation<ProviderProbeSnapshot> {
  return action<ProviderProbeSnapshot>((resolve) => {
    const controller = new AbortController();
    let active = true;
    const sourceEnv = options.env ?? process.env;
    const env = Object.fromEntries(
      Object.entries(sourceEnv).filter(([, value]) => value !== undefined)
    ) as Record<string, string>;
    const cwd = options.cwd ?? process.cwd();
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_PROBE_TIMEOUT_MS;

    void Promise.all(
      LLM_TOOL_PREFERENCE.map(async (provider) => {
        const result = await runBoundedSubprocess({
          argv: [providerBinPath(provider, sourceEnv), '--version'],
          cwd,
          env,
          timeoutMs,
          maxOutputBytes: PROVIDER_PROBE_MAX_OUTPUT_BYTES,
          signal: controller.signal,
        });
        return [provider, providerProbeState(result)] as const;
      })
    ).then((entries) => {
      if (!active) return;
      resolve(Object.fromEntries(entries) as Record<LlmProvider, ProviderProbeState>);
    });

    return () => {
      active = false;
      controller.abort();
    };
  });
}

function providerProbeState(result: {
  exit_code: number | null;
  killed_reason: string | null;
  spawn_error: { code?: string } | null;
}): ProviderProbeState {
  if (result.spawn_error?.code === 'ENOENT') return 'absent';
  if (result.killed_reason !== null) return 'unverified';
  return result.exit_code === 0 ? 'present' : 'absent';
}

export function selectDefaultProvider(
  tool: 'auto' | LlmProvider | 'none',
  snapshot: ProviderProbeSnapshot
): LlmProvider | null {
  if (tool === 'claude' || tool === 'codex') return tool;
  if (tool === 'none') return null;
  for (const provider of LLM_TOOL_PREFERENCE) {
    if (snapshot[provider] === 'present') return provider;
  }
  for (const provider of LLM_TOOL_PREFERENCE) {
    if (snapshot[provider] === 'unverified') return provider;
  }
  return null;
}
