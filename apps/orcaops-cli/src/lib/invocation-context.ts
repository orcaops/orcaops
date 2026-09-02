import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-invocation overrides for `cwd` and `env`. Plumbed by the
 * in-process test harness (`InProcessAgent`) so concurrent
 * parallel agents — each running in its own temp repo with its own
 * `CLAUDE_SESSION_ID` / `XDG_STATE_HOME` — observe distinct state
 * inside a single Node process.
 *
 * Production CLI invocations never set this; readers fall back to
 * `process.cwd()` / `process.env` so behavior is unchanged.
 */
export interface InvocationContext {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Cloud target injected by the selected executable entrypoint. */
  cloudBaseUrl?: string;
  /**
   * The parsed `--root` flag for this invocation, written by the
   * Commander `preAction` hook via `setInvocationRootOverride`. Lets the
   * root resolver honor an explicit `--root` without any module-level
   * state — isolated per in-process agent frame.
   */
  rootOverride?: string;
  /**
   * The parsed `--invoked-by-agent` flag for this invocation, written by
   * the Commander `preAction` hook via `setInvocationInvokedByAgent`.
   * Same pattern as `rootOverride`: consumers that run outside the
   * action body (usage stamping in `runCaptureWithSync`) can reach the
   * flag without threading it through every action signature.
   */
  invokedByAgentOverride?: string;
}

const als = new AsyncLocalStorage<InvocationContext>();

/**
 * Run `fn` with `ctx` as the ambient invocation context. Awaits the
 * function's return value so the ALS frame outlives any async work
 * inside `fn`. Nested calls observe the most-recent `runInInvocationContext`
 * frame (standard `AsyncLocalStorage.run` semantics).
 */
export function runInInvocationContext<T>(
  ctx: InvocationContext,
  fn: () => T | Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    als.run(ctx, () => {
      Promise.resolve().then(fn).then(resolve, reject);
    });
  });
}

/**
 * The cwd the current invocation should treat as the repo root, falling
 * back to `process.cwd()` when no invocation context is active.
 */
export function getInvocationCwd(): string {
  return als.getStore()?.cwd ?? process.cwd();
}

/**
 * The env the current invocation should consult for `process.env`-style
 * reads (`CLAUDE_SESSION_ID`, `XDG_STATE_HOME`, `ORCAOPS_*`, etc.),
 * falling back to `process.env` when no invocation context is active.
 */
export function getInvocationEnv(): NodeJS.ProcessEnv {
  return als.getStore()?.env ?? process.env;
}

/** The cloud target injected for this invocation, when one was provided. */
export function getInvocationCloudBaseUrl(): string | undefined {
  return als.getStore()?.cloudBaseUrl;
}

/**
 * Whether a `CI`-style env value means "in CI". A bare presence check is a footgun:
 * `CI=false` / `CI=0` are common and must read as NOT-CI. True when the value is present
 * and not one of the falsy strings (`''`, `false`, `0`, `no`, `off`).
 */
export function isCi(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== 'false' && v !== '0' && v !== 'no' && v !== 'off';
}

/**
 * The `--root` override for the current invocation (the parsed `--root`
 * flag), or `undefined` when unset / no active frame. Read by the root
 * resolver; written by the CLI's Commander `preAction` hook.
 */
export function getInvocationRootOverride(): string | undefined {
  return als.getStore()?.rootOverride;
}

/**
 * Record the `--root` flag value on the current invocation frame. No-op
 * when no frame is active. The setter exists because `als` is
 * module-private — the `preAction` hook cannot reach the store directly.
 */
export function setInvocationRootOverride(value: string | undefined): void {
  const store = als.getStore();
  if (store) store.rootOverride = value;
}

/**
 * The `--invoked-by-agent` override for the current invocation, or
 * `undefined` when unset / no active frame. Read by the invoking-agent
 * resolver; written by the CLI's Commander `preAction` hook.
 */
export function getInvocationInvokedByAgent(): string | undefined {
  return als.getStore()?.invokedByAgentOverride;
}

/**
 * Record the `--invoked-by-agent` flag value on the current invocation
 * frame. No-op when no frame is active (mirrors `setInvocationRootOverride`).
 */
export function setInvocationInvokedByAgent(value: string | undefined): void {
  const store = als.getStore();
  if (store) store.invokedByAgentOverride = value;
}
