import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  scrubEvaluatorDiagnostic,
  scrubEvaluatorDiagnosticAndBound,
} from '@orcaops/evaluator-protocol/secrets';
import {
  type BoundedSubprocessResult,
  runBoundedSubprocess,
} from '@orcaops/evaluator-protocol/subprocess';

import { claudePreparedInputAdapter } from './claude-code/prepared-input.js';
import { codexRestrictedPreparedInputAdapter } from './codex/prepared-input.js';
import { type LlmProvider } from './detect.js';
import { type JsonRepair, readJsonAnswer } from './json-rescue.js';
import type {
  PreparedInputAdapter,
  ProviderOutcome,
  TokenUsage,
} from './prepared-input-adapter.js';
import { resolvePreparedInputExecutable } from './prepared-input-executable.js';
import {
  type CapabilityRefusal,
  type EffectiveCallSettings,
  isSupportedProvider,
  type NoToolCallRequest,
  PROVIDER_CAPABILITIES,
  resolveNoToolCall,
} from './provider-capabilities.js';
import type { JsonSchema } from './types.js';

export type { TokenUsage } from './prepared-input-adapter.js';

const DEFAULT_KILL_GRACE_MS = 1000;

// runBoundedSubprocess keeps confirming a SIGKILL for up to 500ms plus one 25ms
// poll before it gives up. Keep this at or above that window, or a call that
// needed the whole escalation outlives its deadline.
const KILL_CONFIRMATION_RESERVE_MS = 600;

// Node runs a timer longer than this after 1ms instead of refusing it.
const MAX_TIMER_MS = 2 ** 31 - 1;

const DIAGNOSTIC_EXCERPT_CHARS = 600;
const FAILURE_STDOUT_BYTES = 64 * 1024;
const FAILURE_STDERR_BYTES = 8 * 1024;

const STOP_NOT_CONFIRMED =
  ' The provider process was not confirmed stopped and may still be running.';

const ADAPTERS: Readonly<Record<LlmProvider, PreparedInputAdapter | null>> = {
  claude: claudePreparedInputAdapter,
  codex: codexRestrictedPreparedInputAdapter,
};

export interface PreparedInputCallOptions extends NoToolCallRequest {
  /** The prepared text to interpret. Sent on stdin, never as an argument. */
  preparedInput: string;
  /** The full response instructions. Always part of the request body. */
  instructions: string;
  /** Optional framing placed ahead of the instructions in the system prompt. */
  systemPrompt?: string;
  outputSchema?: JsonSchema | null;
  /**
   * Cap on Orcaops-supplied UTF-8 bytes: body, system prompt, and schema. Provider-added
   * base context or global instructions are outside this count.
   */
  maxInputBytes: number;
  /** Cap on the UTF-8 bytes of the answer. */
  maxOutputBytes: number;
  /**
   * The whole call's deadline, termination included: the provider is signalled
   * early enough that SIGTERM, the grace, SIGKILL, and its confirmation all
   * finish inside it.
   */
  timeoutMs: number;
  /** Opt-in private diagnostics; default callers must not retain failed provider content. */
  retainFailureOutput?: boolean;
  signal?: AbortSignal;
  /**
   * Base environment for the provider and for the `ORCAOPS_CLAUDE_PATH` /
   * `ORCAOPS_CODEX_PATH` binary overrides. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /** SIGTERM→SIGKILL grace. Tests shorten it; production takes the default. */
  killGraceMs?: number;
  /**
   * Where the per-call working directory is created. Defaults to the OS temp
   * directory. A location inside a git working tree is refused.
   */
  scratchParentDir?: string;
  /**
   * What was spawned, as soon as it exists. A caller that must be able to stop
   * this call after its own death records the group here, before the call
   * returns; the deadline this function enforces holds only while this process
   * lives.
   */
  onProviderProcess?: (process: PreparedInputProcess) => void;
}

export interface PreparedInputProcess {
  pid: number;
  /**
   * The group to signal with `-pgid`. The provider leads its own group on
   * POSIX, so it is the pid; Windows has no process groups and reports null.
   */
  processGroupId: number | null;
}

export type PreparedInputFailureCode =
  | 'INVALID_REQUEST'
  | 'PROVIDER_UNAVAILABLE'
  | 'CAPABILITY_REFUSED'
  | 'INPUT_TOO_LARGE'
  | 'WORKING_DIRECTORY_IN_REPOSITORY'
  | 'OUTPUT_TOO_LARGE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'BUDGET_EXCEEDED'
  | 'PROVIDER_ERROR'
  | 'UNPARSEABLE_STREAM'
  | 'MULTIPLE_RESULTS'
  | 'EMPTY_RESPONSE'
  | 'STRUCTURED_ANSWER_MISSING'
  | 'ANSWER_CUT_OFF'
  | 'TOOL_USE_OBSERVED'
  | 'TOOLS_AVAILABLE'
  | 'NO_TOOL_MODE_UNCONFIRMED'
  | 'SPAWN_FAILURE';

interface PreparedInputCallReport {
  provider: LlmProvider;
  durationMs: number;
  /** The model the provider says it ran; null when it did not say. */
  reportedModel: string | null;
  /** Null means the provider reported none — unknown, not zero. */
  usage: TokenUsage | null;
  /** Null means the provider reported none — unknown, not zero. */
  costUsd: number | null;
}

export interface PreparedInputCallCompleted extends PreparedInputCallReport {
  status: 'completed';
  body: string;
  settings: EffectiveCallSettings;
  inputBytes: number;
  outputBytes: number;
  jsonRepair?: JsonRepair;
}

export interface PreparedInputCallFailed extends PreparedInputCallReport {
  status: 'failed';
  code: PreparedInputFailureCode;
  message: string;
  /** False guarantees no model request was started. A compatibility preflight may have run. */
  providerStarted: boolean;
  /**
   * True only when it is known that no provider process is left: none was
   * started, it ended by itself, or it was observed to stop. False means it
   * may still be running and spending, so a replacement call must wait.
   */
  terminationConfirmed: boolean;
  hardKilled: boolean;
  settings: EffectiveCallSettings | null;
  refusals: CapabilityRefusal[];
  /** Scrubbed, bounded stream tails for diagnosis only, never a publishable answer. */
  failureOutput?: {
    format: 'scrubbed-stream-tails/v1';
    stdout: { text: string; originalBytes: number; truncated: boolean };
    stderr: { text: string; originalBytes: number; truncated: boolean };
  };
}

export type PreparedInputCallResult = PreparedInputCallCompleted | PreparedInputCallFailed;

export interface PreparedInputRequestParts {
  provider: LlmProvider;
  preparedInput: string;
  instructions: string;
  systemPrompt?: string;
  outputSchema?: JsonSchema | null;
}

export interface MeasuredPreparedInputRequest {
  /** What goes to the provider's stdin. */
  body: string;
  /** What goes to the provider's system prompt; null when it has none. */
  systemPrompt: string | null;
  outputSchemaJson: string | null;
  /** Orcaops-supplied UTF-8 bytes across all three: the figure `maxInputBytes` limits. */
  bytes: number;
}

/**
 * Compose the content Orcaops supplies, so a caller can size it against
 * `maxInputBytes` before asking. Provider-added base context or global
 * instructions are not observable here. The instructions are always in the
 * body; a provider with a system prompt receives them there as well, and one
 * without has the caller's framing folded into the body instead of dropped.
 */
export function measurePreparedInputRequest(
  parts: PreparedInputRequestParts
): MeasuredPreparedInputRequest {
  const hasSystemPrompt = PROVIDER_CAPABILITIES[parts.provider].supportsSystemPrompt;
  const systemPrompt = hasSystemPrompt
    ? joinSections([parts.systemPrompt, parts.instructions])
    : null;
  const body = joinSections([
    hasSystemPrompt ? undefined : parts.systemPrompt,
    parts.instructions,
    parts.preparedInput,
  ]);
  const outputSchemaJson = parts.outputSchema ? JSON.stringify(parts.outputSchema) : null;
  return {
    body,
    systemPrompt,
    outputSchemaJson,
    bytes:
      Buffer.byteLength(body, 'utf8') +
      Buffer.byteLength(systemPrompt ?? '', 'utf8') +
      Buffer.byteLength(outputSchemaJson ?? '', 'utf8'),
  };
}

function joinSections(sections: ReadonlyArray<string | undefined>): string {
  return sections.filter((section) => section !== undefined && section.length > 0).join('\n\n');
}

/**
 * Send prepared text under an explicit tool-access policy and hard limits on
 * input size, answer size, and time. Never throws and never reports a failure
 * as a completion.
 *
 * The deadline holds only while this process lives. The provider leads its own
 * process group, so if the caller dies mid-call nothing here is left to stop
 * it: a caller that must be able to stop it afterwards retains the group
 * through `onProviderProcess` and terminates it itself.
 */
export async function runPreparedInputCall(
  options: PreparedInputCallOptions
): Promise<PreparedInputCallResult> {
  const startedAt = Date.now();
  const { provider } = options;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const terminationReserveMs = killGraceMs + KILL_CONFIRMATION_RESERVE_MS;

  const refuse = (
    code: PreparedInputFailureCode,
    message: string,
    extra: Partial<Pick<PreparedInputCallFailed, 'settings' | 'refusals'>> = {}
  ): PreparedInputCallFailed => ({
    status: 'failed',
    code,
    message,
    provider,
    providerStarted: false,
    terminationConfirmed: true,
    hardKilled: false,
    durationMs: Date.now() - startedAt,
    reportedModel: null,
    usage: null,
    costUsd: null,
    settings: extra.settings ?? null,
    refusals: extra.refusals ?? [],
  });

  const invalid = invalidRequestReason(options, terminationReserveMs);
  if (invalid !== null) return refuse('INVALID_REQUEST', invalid);

  const resolution = resolveNoToolCall(options);
  if (resolution.status === 'unavailable') {
    const providerUnusable = resolution.refusals.some(
      (refusal) => refusal.capability === 'no_tool_execution'
    );
    return refuse(
      providerUnusable ? 'PROVIDER_UNAVAILABLE' : 'CAPABILITY_REFUSED',
      resolution.refusals.map((refusal) => refusal.message).join(' '),
      { refusals: resolution.refusals }
    );
  }
  const { settings } = resolution;
  const adapter = ADAPTERS[provider];
  if (adapter === null) {
    return refuse(
      'PROVIDER_UNAVAILABLE',
      `${provider} has no adapter that enforces no-tool execution.`
    );
  }

  let request: MeasuredPreparedInputRequest;
  try {
    request = measurePreparedInputRequest(options);
  } catch (err) {
    return refuse('INVALID_REQUEST', `The output schema is not serializable: ${errorText(err)}`);
  }
  if (request.bytes > options.maxInputBytes) {
    return refuse(
      'INPUT_TOO_LARGE',
      `The request is ${request.bytes} bytes, over the limit of ${options.maxInputBytes}. ` +
        `Nothing was sent.`,
      { settings }
    );
  }

  const cancelledBeforeStart = (): PreparedInputCallFailed =>
    refuse('CANCELLED', 'The call was cancelled before the provider was started.', { settings });
  if (options.signal?.aborted) return cancelledBeforeStart();

  const scratchParent = options.scratchParentDir ?? tmpdir();
  let workDir: string;
  try {
    const workTree = await enclosingGitWorkTree(scratchParent);
    if (workTree !== null) {
      return refuse(
        'WORKING_DIRECTORY_IN_REPOSITORY',
        `The provider would run under ${scratchParent}, which is inside the git working tree ` +
          `at ${workTree}. A provider must never run inside a repository: ` +
          (options.scratchParentDir === undefined
            ? 'point TMPDIR at a directory outside any repository.'
            : 'choose a scratch parent directory outside any repository.'),
        { settings }
      );
    }
    workDir = await mkdtemp(path.join(scratchParent, 'orcaops-prepared-input-'));
  } catch (err) {
    return refuse(
      'SPAWN_FAILURE',
      `Could not create a working directory for the provider: ${errorText(err)}`,
      { settings }
    );
  }

  let providerStarted = false;
  let run: BoundedSubprocessResult | null = null;
  try {
    if (options.signal?.aborted) return cancelledBeforeStart();
    let answerWindowMs = options.timeoutMs - terminationReserveMs - (Date.now() - startedAt);
    if (answerWindowMs <= 0) {
      return refuse('TIMEOUT', 'The deadline passed before the provider could be started.', {
        settings,
      });
    }

    const baseEnv = options.env ?? process.env;
    const executable = await resolvePreparedInputExecutable(provider, baseEnv, process.cwd());
    if ('error' in executable)
      return refuse('PROVIDER_UNAVAILABLE', executable.error, { settings });
    answerWindowMs = options.timeoutMs - terminationReserveMs - (Date.now() - startedAt);
    if (answerWindowMs <= 0) {
      return refuse('TIMEOUT', 'The deadline passed while resolving the provider executable.', {
        settings,
      });
    }
    const outputSchemaFile =
      options.outputSchema === undefined || options.outputSchema === null
        ? null
        : path.join(workDir, 'output-schema.json');
    const invocationRequest = {
      settings,
      systemPrompt: request.systemPrompt,
      outputSchema: options.outputSchema ?? null,
      outputSchemaFile,
      baseEnv,
    };
    const preflight = adapter.preflight?.(invocationRequest);
    if (preflight !== undefined) {
      const preflightRun = await runBoundedSubprocess({
        argv: [...executable.argv, ...preflight.invocation.args],
        cwd: workDir,
        env: definedEntries(preflight.invocation.env),
        stdin: '',
        timeoutMs: Math.min(5000, answerWindowMs),
        maxOutputBytes: 4096,
        killGraceMs,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      const preflightFailure = preflightFailureMessage(provider, preflightRun, preflight.validate);
      if (preflightFailure !== null) {
        const stopKnown = preflightRun.termination_confirmed;
        return {
          ...refuse(
            preflightRun.killed_reason === 'canceled' ? 'CANCELLED' : 'PROVIDER_UNAVAILABLE',
            preflightFailure + (stopKnown ? '' : STOP_NOT_CONFIRMED),
            { settings }
          ),
          terminationConfirmed: stopKnown,
          hardKilled: preflightRun.hard_killed,
        };
      }
      answerWindowMs = options.timeoutMs - terminationReserveMs - (Date.now() - startedAt);
      if (answerWindowMs <= 0) {
        return refuse('TIMEOUT', 'The deadline passed during the provider preflight.', {
          settings,
        });
      }
    }
    if (options.signal?.aborted) return cancelledBeforeStart();
    if (outputSchemaFile !== null) {
      await writeFile(outputSchemaFile, JSON.stringify(options.outputSchema), { mode: 0o600 });
    }
    const invocation = adapter.invocation(invocationRequest);
    providerStarted = true;
    run = await runBoundedSubprocess({
      argv: [...executable.argv, ...invocation.args],
      cwd: workDir,
      env: definedEntries(invocation.env),
      stdin: request.body,
      timeoutMs: answerWindowMs,
      maxOutputBytes: adapter.maxStreamBytes(options.maxOutputBytes),
      killGraceMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onProviderProcess !== undefined
        ? {
            onSpawn: (pid: number) =>
              options.onProviderProcess!({
                pid,
                processGroupId: process.platform === 'win32' ? null : pid,
              }),
          }
        : {}),
    });

    return settle({
      run,
      outcome: adapter.interpret(run.stdout, { outputSchema: options.outputSchema ?? null }),
      options,
      settings,
      inputBytes: request.bytes,
      startedAt,
    });
  } catch (err) {
    // Whether a started provider stopped is known only from the subprocess
    // result; a throw that arrived without one leaves it unknown.
    const neverStarted = !providerStarted || (run !== null && run.spawn_error !== null);
    const stopKnown = neverStarted || run?.termination_confirmed === true;
    return {
      ...refuse(
        'PROVIDER_ERROR',
        `The call to ${provider} failed unexpectedly: ${errorText(err)}` +
          (stopKnown ? '' : STOP_NOT_CONFIRMED),
        { settings }
      ),
      providerStarted: !neverStarted,
      terminationConfirmed: stopKnown,
      hardKilled: run?.hard_killed ?? false,
      ...(options.retainFailureOutput && run ? { failureOutput: failureOutput(run) } : {}),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The nearest ancestor of `dir`, itself included, that holds a `.git` entry. */
async function enclosingGitWorkTree(dir: string): Promise<string | null> {
  let current = await realpath(dir);
  for (;;) {
    const hasGitEntry = await lstat(path.join(current, '.git')).then(
      () => true,
      () => false
    );
    if (hasGitEntry) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function invalidRequestReason(
  options: PreparedInputCallOptions,
  terminationReserveMs: number
): string | null {
  if (!isSupportedProvider(options.provider)) {
    return `${JSON.stringify(options.provider)} is not a supported provider.`;
  }
  if (
    options.toolAccess !== undefined &&
    options.toolAccess !== 'none' &&
    options.toolAccess !== 'codex_restricted'
  ) {
    return `toolAccess must be "none" or "codex_restricted"; received ${JSON.stringify(options.toolAccess)}.`;
  }
  for (const name of ['maxInputBytes', 'maxOutputBytes'] as const) {
    if (!Number.isSafeInteger(options[name]) || options[name] <= 0) {
      return `${name} must be a positive whole number of bytes; received ${String(options[name])}.`;
    }
  }
  if (
    options.killGraceMs !== undefined &&
    !(options.killGraceMs >= 0 && options.killGraceMs <= MAX_TIMER_MS)
  ) {
    return `killGraceMs must be between 0 and ${MAX_TIMER_MS}; received ${String(options.killGraceMs)}.`;
  }
  if (options.timeoutMs > MAX_TIMER_MS) {
    return `timeoutMs of ${String(options.timeoutMs)} is over the longest deadline a timer can hold, ${MAX_TIMER_MS}ms.`;
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= terminationReserveMs) {
    return (
      `timeoutMs of ${String(options.timeoutMs)} leaves the provider no time to answer: ` +
      `${terminationReserveMs}ms of it is reserved for stopping the provider.`
    );
  }
  if (options.instructions.trim().length === 0) return 'The response instructions are empty.';
  if (options.preparedInput.trim().length === 0) return 'The prepared input is empty.';
  return null;
}

function preflightFailureMessage(
  provider: LlmProvider,
  run: BoundedSubprocessResult,
  validate: (stdout: string) => string | null
): string | null {
  if (run.spawn_error !== null) {
    const errno = run.spawn_error.code !== undefined ? ` (${run.spawn_error.code})` : '';
    return `Could not start ${provider} for its compatibility preflight${errno}: ${run.spawn_error.message}`;
  }
  if (run.killed_reason === 'canceled')
    return `The ${provider} compatibility preflight was cancelled.`;
  if (run.killed_reason === 'timeout') return `The ${provider} compatibility preflight timed out.`;
  if (run.killed_reason === 'output-too-large') {
    return `The ${provider} compatibility preflight produced unexpectedly large output.`;
  }
  if (run.exit_code !== 0) {
    const diagnostic = scrubEvaluatorDiagnosticAndBound(
      run.stderr.trim(),
      DIAGNOSTIC_EXCERPT_CHARS
    );
    return `${provider} compatibility preflight exited with code ${run.exit_code ?? 'unknown'}${diagnostic.length > 0 ? `: ${diagnostic}` : '.'}`;
  }
  return validate(run.stdout);
}

function settle(params: {
  run: BoundedSubprocessResult;
  outcome: ProviderOutcome;
  options: PreparedInputCallOptions;
  settings: EffectiveCallSettings;
  inputBytes: number;
  startedAt: number;
}): PreparedInputCallResult {
  const { run, outcome, options, settings, inputBytes, startedAt } = params;
  const { provider } = options;
  const report = {
    provider,
    durationMs: Date.now() - startedAt,
    reportedModel: outcome.reportedModel,
    usage: outcome.usage,
    costUsd: outcome.costUsd,
  };
  const fail = (code: PreparedInputFailureCode, message: string): PreparedInputCallFailed => ({
    status: 'failed',
    code,
    message: run.termination_confirmed ? message : `${message}${STOP_NOT_CONFIRMED}`,
    ...report,
    providerStarted: run.spawn_error === null,
    terminationConfirmed: run.termination_confirmed,
    hardKilled: run.hard_killed,
    settings,
    refusals: [],
    ...(options.retainFailureOutput ? { failureOutput: failureOutput(run) } : {}),
  });

  if (run.spawn_error !== null) {
    const errno = run.spawn_error.code !== undefined ? ` (${run.spawn_error.code})` : '';
    return fail('SPAWN_FAILURE', `Could not start ${provider}${errno}: ${run.spawn_error.message}`);
  }
  const strictlyToolFree = settings.toolAccess === 'none';
  const policyDescription = strictlyToolFree ? 'no-tool mode' : 'restricted Codex mode';
  const discarded = `The ${policyDescription} did not hold; the answer is discarded.`;
  if (outcome.toolUse.length > 0) {
    return fail(
      'TOOL_USE_OBSERVED',
      `${provider} was started in ${policyDescription}, yet the stream shows tool use: ` +
        `${outcome.toolUse.join('; ')}. ${discarded}`
    );
  }
  if (outcome.toolsAvailable.length > 0) {
    return fail(
      'TOOLS_AVAILABLE',
      `${provider} was started in ${policyDescription}, yet it reported the model was offered: ` +
        `${outcome.toolsAvailable.join('; ')}. ${discarded}`
    );
  }
  if (run.killed_reason === 'canceled') {
    return fail('CANCELLED', `The call was cancelled and ${provider} was stopped.`);
  }
  if (run.killed_reason === 'timeout') {
    return fail(
      'TIMEOUT',
      `${provider} did not finish in time for the ${options.timeoutMs}ms deadline and was stopped.`
    );
  }
  if (run.killed_reason === 'output-too-large') {
    return fail(
      'OUTPUT_TOO_LARGE',
      `${provider} wrote more than an answer of ${options.maxOutputBytes} bytes can need and was stopped.`
    );
  }
  if (outcome.resultCount > 1) {
    return fail(
      'MULTIPLE_RESULTS',
      `${provider} reported ${outcome.resultCount} results where exactly one is expected, ` +
        `so none of them is trusted.`
    );
  }
  if (outcome.failure !== null) {
    return fail(
      outcome.failure.kind === 'budget_exceeded' ? 'BUDGET_EXCEEDED' : 'PROVIDER_ERROR',
      scrubEvaluatorDiagnosticAndBound(outcome.failure.message, DIAGNOSTIC_EXCERPT_CHARS)
    );
  }
  if (run.exit_code !== 0) {
    const stderr = scrubEvaluatorDiagnosticAndBound(run.stderr.trim(), DIAGNOSTIC_EXCERPT_CHARS);
    const ending =
      run.exit_code !== null ? `code ${run.exit_code}` : `signal ${run.signal ?? 'unknown'}`;
    return fail(
      'PROVIDER_ERROR',
      `${provider} exited with ${ending}${stderr.length > 0 ? `: ${stderr}` : '.'}`
    );
  }
  if (outcome.resultCount === 0) {
    return fail('UNPARSEABLE_STREAM', `${provider} exited cleanly without reporting a result.`);
  }
  if (strictlyToolFree && !outcome.toolOfferStated) {
    return fail(
      'NO_TOOL_MODE_UNCONFIRMED',
      `${provider} never stated which tools the model was offered, so the absence of tools ` +
        `was not observed. The answer is discarded.`
    );
  }
  if (outcome.cutOffReason !== null) {
    return fail(
      'ANSWER_CUT_OFF',
      `${provider} stopped generating with reason "${outcome.cutOffReason}", so the answer is ` +
        `not whole. It is discarded; the same input would end the same way.`
    );
  }
  let body = outcome.body;
  let jsonRepair: JsonRepair | undefined;
  let structuredAnswerMissing = outcome.structuredAnswerMissing;
  if (
    outcome.structuredAnswerMissing &&
    Buffer.byteLength(body, 'utf8') <= options.maxOutputBytes
  ) {
    const rescued = readJsonAnswer(body);
    if (rescued !== null) {
      body = rescued.body;
      jsonRepair = rescued.jsonRepair;
      structuredAnswerMissing = false;
    }
  }
  if (structuredAnswerMissing) {
    return fail(
      'STRUCTURED_ANSWER_MISSING',
      `A structured answer was requested and ${provider} returned none. ` +
        `Its free-text answer is discarded.`
    );
  }
  if (body.trim().length === 0) {
    return fail('EMPTY_RESPONSE', `${provider} reported a result with an empty answer.`);
  }
  const outputBytes = Buffer.byteLength(body, 'utf8');
  if (outputBytes > options.maxOutputBytes) {
    return fail(
      'OUTPUT_TOO_LARGE',
      `The answer is ${outputBytes} bytes, over the limit of ${options.maxOutputBytes}. ` +
        `It is discarded, not truncated.`
    );
  }
  return {
    status: 'completed',
    ...report,
    body,
    settings,
    inputBytes,
    outputBytes,
    ...(jsonRepair === undefined ? {} : { jsonRepair }),
  };
}

function failureOutput(
  run: BoundedSubprocessResult
): NonNullable<PreparedInputCallFailed['failureOutput']> {
  const tail = (text: string, maxBytes: number) => {
    const scrubbed = Buffer.from(scrubEvaluatorDiagnostic(text), 'utf8');
    let start = Math.max(0, scrubbed.length - maxBytes);
    while (start < scrubbed.length && (scrubbed[start]! & 0xc0) === 0x80) start++;
    return {
      text: scrubbed.toString('utf8', start),
      originalBytes: Buffer.byteLength(text, 'utf8'),
      truncated: start > 0,
    };
  };
  return {
    format: 'scrubbed-stream-tails/v1',
    stdout: tail(run.stdout, FAILURE_STDOUT_BYTES),
    stderr: tail(run.stderr, FAILURE_STDERR_BYTES),
  };
}

function definedEntries(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
