// The one way a runner-established execution is produced: a bounded subprocess handed copies of
// inputs this helper has already identified, so what the observation names is what the process was
// given rather than what a caller says it read.
//
// Nothing else may mint `runner_established`. An agent reporting a command and its exit code is an
// agent-reported observation however carefully it is worded, so `publishProjectObservation` refuses
// the kind outright and `publishProjectObservedRun` takes only a run this module returned. The
// proof is a module-private set: an object this module never produced is not in it, and nothing
// outside the module can put one there.
//
// **The process reads copies.** Digesting an input and then handing the process its original path
// leaves the window §12 names: another writer changes the file, the process reads the change, and
// the change is undone before the run ends, so equal before-and-after digests name bytes nothing
// read. Copying first closes it — the copy's path is known only to this run — and the identities
// are content identities of the copies: `<name>@sha256:<digest>` for a file, so two runs over the
// same bytes name the same input.
//
// An input that is not a regular file cannot be copied or digested. It is still handed over, at its
// own path, and named as unidentified: the basis drops to `partial` and a limit says which input
// and why.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type BoundedSubprocessResult,
  runBoundedSubprocess,
} from '@orcaops/evaluator-protocol/subprocess';

import { ProjectDatabaseError } from './errors.js';
import type { Observation } from '../../schema/knowledge-contract.js';

type InputIdentity = Observation['known_inputs'][number];

/** One retained input the runner hands over, by absolute path. */
export interface ObservedRunInput {
  readonly name: string;
  readonly path: string;
}

export interface ObservedRunRequest {
  /** What established the execution, recorded as the observation's runner. */
  readonly runner: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly inputs: readonly ObservedRunInput[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

/**
 * The observation an execution supports, without the identity, observer, source and method that
 * belong to whoever publishes it.
 */
export type ObservedRunObservation = Pick<
  Observation,
  | 'execution'
  | 'input_basis'
  | 'known_inputs'
  | 'outcome'
  | 'detail'
  | 'retained_artifacts'
  | 'started_at'
  | 'finished_at'
  | 'limits'
>;

export interface ObservedRun {
  readonly observation: ObservedRunObservation;
  readonly result: BoundedSubprocessResult;
}

// Membership is the whole proof that a runner established this execution, so it is held here and
// nowhere else: a caller can copy every field of an ObservedRun and still not be in this set.
const established = new WeakSet<ObservedRun>();

/** Whether this run is one {@link runObservedProcess} returned, rather than one shaped like it. */
export const runnerEstablished = (run: ObservedRun): boolean => established.has(run);

/** The environment variable and the stdin document the inputs are handed over through. */
export const OBSERVED_INPUTS_VARIABLE = 'ORCAOPS_OBSERVED_INPUTS';

const invalid = (message: string, cause?: unknown): never => {
  throw new ProjectDatabaseError('INVALID_INPUT', message, cause === undefined ? {} : { cause });
};

interface HandedOver {
  readonly input: ObservedRunInput;
  /** Where the process reads it: the copy for a regular file, the original for anything else. */
  readonly path: string;
  /** The digest of what was copied, or null for an input this runner could not identify. */
  readonly sha256: string | null;
  /** Why it could not be identified, for the limit the observation carries. */
  readonly unidentified: string | null;
}

const identityOf = (handed: HandedOver): InputIdentity => ({
  kind: 'file',
  identity:
    handed.sha256 === null
      ? `${handed.input.name}@unidentified`
      : `${handed.input.name}@sha256:${handed.sha256}`,
});

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

// A copy lands under its own index, so the name the process sees is the input's own basename and
// no two inputs can collide or reach outside the private directory.
function copyPath(at: string, index: number, input: ObservedRunInput): string {
  const base = path.basename(input.path);
  return path.join(at, String(index), base === '.' || base === '..' ? String(index) : base);
}

async function handOver(at: string, input: ObservedRunInput, index: number): Promise<HandedOver> {
  let described;
  try {
    described = await stat(input.path);
  } catch (cause) {
    return invalid(`A runner hands over inputs it can find: ${input.name} is not there`, cause);
  }
  if (!described.isFile())
    // A directory or a special file has no bytes to copy or digest. The process still gets it;
    // what it cannot get is an identity, and the observation says so rather than inventing one.
    return {
      input,
      path: input.path,
      sha256: null,
      unidentified: 'it is not a regular file, so it was handed over in place and not identified',
    };
  let bytes: Buffer;
  try {
    bytes = await readFile(input.path);
  } catch (cause) {
    return invalid(
      `A runner hands over inputs it can read: ${input.name} could not be read`,
      cause
    );
  }
  const copy = copyPath(at, index, input);
  // The copy keeps the private directory's own mode, so it is never world-readable on its way in.
  await mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
  await writeFile(copy, bytes, { mode: 0o600 });
  return { input, path: copy, sha256: digest(bytes), unidentified: null };
}

function outcomeOf(result: BoundedSubprocessResult): 'passed' | 'failed' | 'errored' {
  if (result.spawn_error !== null || result.killed_reason !== null) return 'errored';
  return result.exit_code === 0 ? 'passed' : 'failed';
}

export async function runObservedProcess(request: ObservedRunRequest): Promise<ObservedRun> {
  if (request.inputs.length === 0)
    invalid(
      'A runner-established execution names the retained inputs it consumed; supply at least one'
    );
  const names = new Set(request.inputs.map((input) => input.name));
  if (names.size !== request.inputs.length) invalid('Each handed-over input is named once');

  const at = await mkdtemp(path.join(tmpdir(), 'orcaops-observed-'));
  try {
    const handed: HandedOver[] = [];
    for (const [index, input] of request.inputs.entries())
      handed.push(await handOver(at, input, index));
    const handover = JSON.stringify(
      handed.map((entry) => ({ name: entry.input.name, path: entry.path, sha256: entry.sha256 }))
    );
    const started_at = new Date().toISOString();
    const result = await runBoundedSubprocess({
      argv: request.argv,
      cwd: request.cwd,
      env: { ...request.env, [OBSERVED_INPUTS_VARIABLE]: handover },
      stdin: handover,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      signal: request.signal,
    });
    const finished_at = new Date().toISOString();

    // Nothing but the process itself can reach a copy, so a copy that moved is the process
    // rewriting its own input: the basis drops rather than the digest being quietly updated. A copy
    // it removed counts the same — the run is over and its result is what it is, so this reports
    // what became of the inputs rather than failing the whole call over one of them.
    const rewritten: string[] = [];
    for (const entry of handed) {
      if (entry.sha256 === null) continue;
      const now = await readFile(entry.path).then(digest, () => null);
      if (now !== entry.sha256) rewritten.push(entry.input.name);
    }
    const unidentified = handed.filter((entry) => entry.unidentified !== null);
    const consumed = handed.map(identityOf);
    const limits = [
      ...unidentified.map((entry) => `${entry.input.name}: ${entry.unidentified!}`),
      ...(rewritten.length === 0
        ? []
        : [`${rewritten.join(', ')} was rewritten by the process it was handed to`]),
    ];
    const run: ObservedRun = {
      observation: {
        execution: {
          kind: 'runner_established',
          runner: request.runner,
          consumed_inputs: consumed,
        },
        input_basis: limits.length === 0 ? 'snapshot_bound' : 'partial',
        known_inputs: consumed,
        outcome: outcomeOf(result),
        detail: result.spawn_error === null ? null : result.spawn_error.message,
        retained_artifacts: [],
        started_at,
        finished_at,
        limits,
      },
      result,
    };
    established.add(run);
    return run;
  } finally {
    await rm(at, { recursive: true, force: true });
  }
}
