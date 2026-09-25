// A scenario workflow with knowledge processing configured and consented, a provider that answers
// at a pace the caller chooses, and a worker that can be kept beside it for as long as a
// measurement runs.
//
// Consent can only be given at a terminal, so it is given through the seam `knowledge enable`
// declares for tests; a file using this helper mocks `node:tty` as the scenarios do.
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scenarioWorkflow, type ScenarioWorkflow } from './scenario-workflow.js';
import { knowledgeEnableAction } from '../../src/commands/knowledge/enable.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { InteractiveConsentConfirmation } from '../../src/lib/knowledge-processing-grants.js';

export const PACED_KNOWLEDGE_PROPOSER = fileURLToPath(
  new URL('./paced-knowledge-proposer.mjs', import.meta.url)
);

const ORCAOPS_ENTRY = fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url));

/** How the provider answers a call. `none` is processing off, where nothing calls it at all. */
export type ProviderPace =
  | { kind: 'none' }
  | { kind: 'prompt' }
  | { kind: 'delayed'; delayMs: number }
  | { kind: 'failing' };

export interface ProcessingWorkflowOptions {
  pace: ProviderPace;
  /**
   * A file every call appends `<epoch ms> <pid>` to as it begins, before it waits. It is what says
   * when the provider was reached, against what the store says about the act that admitted the job.
   */
  callLog?: string;
  idleExitMs?: number;
}

export interface ProcessingWorkflow {
  workflow: ScenarioWorkflow;
  /** Whether the checkout this workflow captures in has the workload turned on. */
  processingOn: boolean;
  /**
   * The environment of a command run as a person runs it: the provider's pace, and the worker
   * start switch the CLI suite sets left off, so whether a worker starts is the configuration's
   * answer rather than the suite's.
   */
  spawnEnv(): NodeJS.ProcessEnv;
  /** Keep exactly one worker running until the returned stop is awaited. */
  keepAWorkerRunning(): () => Promise<void>;
  cleanup(): Promise<void>;
}

const CONSENT_TERMINAL = {
  isInteractive: () => true,
  ask: () => Promise.resolve('yes'),
  confirm: InteractiveConsentConfirmation.forTermsAcceptedAtTerminal.bind(
    InteractiveConsentConfirmation
  ),
};

function paceEnvironment(options: ProcessingWorkflowOptions): Record<string, string> {
  const environment: Record<string, string> = {};
  if (options.callLog !== undefined) environment.PACED_PROPOSER_CALL_LOG = options.callLog;
  if (options.pace.kind === 'delayed')
    environment.PACED_PROPOSER_DELAY_MS = String(options.pace.delayMs);
  if (options.pace.kind === 'failing') environment.PACED_PROPOSER_FAIL = '1';
  return environment;
}

export async function processingWorkflow(
  options: ProcessingWorkflowOptions
): Promise<ProcessingWorkflow> {
  const processingOn = options.pace.kind !== 'none';
  const workflow = await scenarioWorkflow({
    database: true,
    provider: PACED_KNOWLEDGE_PROPOSER,
  });
  await workflow.writeConfig({
    schema_version: 8,
    install: { scope: 'project' },
    llm: { tool: 'claude' },
    knowledge_processing: {
      enabled: processingOn,
      idle_exit_ms: options.idleExitMs ?? 1_000,
      timeout_ms: 120_000,
    },
  });
  const pace = paceEnvironment(options);
  if (processingOn)
    await runInInvocationContext(
      { cwd: workflow.repoPath, env: { ...process.env, ...workflow.env(pace) } },
      () => knowledgeEnableAction({ terminal: CONSENT_TERMINAL, json: true })
    );

  const spawnEnv = (): NodeJS.ProcessEnv => {
    const environment = { ...process.env, ...workflow.env(pace) } as NodeJS.ProcessEnv;
    delete environment.ORCAOPS_KNOWLEDGE_WORKER_START;
    return environment;
  };

  const workerLog = path.join(workflow.temporary, 'worker-log');
  const keepAWorkerRunning = (): (() => Promise<void>) => {
    let stopped = false;
    let running: ChildProcess | null = null;
    let ended = Promise.resolve();
    const startOne = (): void => {
      const descriptor = openSync(workerLog, 'a');
      try {
        const child = spawn(
          process.execPath,
          [ORCAOPS_ENTRY, 'knowledge', 'worker', '--root', workflow.repoPath],
          {
            cwd: workflow.repoPath,
            env: spawnEnv(),
            stdio: ['ignore', descriptor, descriptor],
          }
        );
        running = child;
        ended = new Promise((resolve) =>
          child.on('exit', () => {
            resolve();
            // A worker exits when its queue goes quiet; production starts another with the next
            // capture that admits work, which nothing in this process can do.
            if (!stopped) startOne();
          })
        );
        child.on('error', () => undefined);
      } finally {
        closeSync(descriptor);
      }
    };
    startOne();
    return async () => {
      stopped = true;
      running?.kill('SIGTERM');
      await ended;
    };
  };

  return {
    workflow,
    processingOn,
    spawnEnv,
    keepAWorkerRunning,
    cleanup: () => workflow.cleanup(),
  };
}
