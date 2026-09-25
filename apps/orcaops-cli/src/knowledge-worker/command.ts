import { run } from 'effection';

import { inspectDatabaseSetup } from '@orcaops/core/history/database-setup';
import { probeProviderAvailability, type ProviderProbeSnapshot } from '@orcaops/llm';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import type { ProjectDatabaseAuthority } from '@orcaops/storage/history/database';

import { type KnowledgeWorkerReport, runKnowledgeWorker } from './loop.js';
import { writeTerminalSafeStdout } from '../io/output.js';
import { getInvocationCwd, getInvocationEnv } from '../lib/invocation-context.js';
import { readProjectId } from '../lib/project-identity.js';
import { resolveRepositoryContext } from '../lib/repository-context.js';

/**
 * `orcaops knowledge worker` — the background worker's own process. It is
 * hidden: it is started by orcaops after a capture, not typed, and it is
 * registered rather than tucked away so the command inventory and the CLI's
 * own visibility test both account for it.
 *
 * It never fails its caller. Its standard output is the worker log the starter
 * points at, so everything it has to say goes there as plain lines and the
 * process always exits 0.
 */

export interface KnowledgeWorkerCommandOptions {
  /** Test seams. A person typing this command passes none of them. */
  signal?: AbortSignal;
  providerAvailability?: ProviderProbeSnapshot;
  idleExitMs?: number;
  heartbeatMs?: number;
  leaseTermMs?: number;
  callLifetimeMs?: number;
  revalidateMs?: number;
  killGraceMs?: number;
  scratchParentDir?: string;
}

function line(text: string): void {
  writeTerminalSafeStdout(`[${new Date().toISOString()}] ${text}\n`);
}

/**
 * Which providers are installed on this machine, probed once for the whole run
 * because the answer is about the machine and not about any one job: it spawns
 * a version check per provider, and a probe per job would spawn one per job.
 *
 * `llm.tool` here is the worker's own checkout's, and it decides only whether
 * to probe at all — a checkout that turned every model call off has nothing to
 * look for. What each job may use is judged per origin:
 * `resolveOriginConfiguration` reads that worktree's own configuration and
 * asks this same snapshot about the provider IT names, so an origin naming a
 * provider this machine does not have parks on `configuration_paused` instead
 * of borrowing the answer for another one.
 */
async function probe(tool: string): Promise<ProviderProbeSnapshot> {
  if (tool === 'none') return { claude: 'absent', codex: 'absent' };
  return run(() =>
    probeProviderAvailability({
      env: getInvocationEnv(),
      cwd: getInvocationCwd(),
      execution: 'prepared-input',
    })
  );
}

export async function knowledgeWorkerAction(
  options: KnowledgeWorkerCommandOptions = {}
): Promise<KnowledgeWorkerReport | null> {
  try {
    const repository = await resolveRepositoryContext({ requireInit: false });
    const projectId = await readProjectId(repository.repo);
    if (projectId === null) {
      line('This repository has no orcaops project identity, so there is nothing to process.');
      return null;
    }
    const root = await normalizeHistoryRoot({
      env: getInvocationEnv(),
      cwd: repository.repoRoot,
    });
    const setup = await inspectDatabaseSetup({
      cwd: repository.repoRoot,
      root: root.resolvedRoot,
      projectId,
    });
    if (setup.state !== 'registered' || setup.initialization === null) {
      line(
        `This checkout has no registered project database (${setup.state}); nothing to process.`
      );
      return null;
    }
    const authority = setup.initialization.authority as ProjectDatabaseAuthority;

    const stop = new AbortController();
    const requestStop = (signal: string) => () => {
      line(`Received ${signal}; cancelling the active call and settling what can be settled.`);
      stop.abort();
    };
    const onTerm = requestStop('SIGTERM');
    const onInt = requestStop('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    options.signal?.addEventListener('abort', () => stop.abort(), { once: true });

    try {
      const report = await runKnowledgeWorker({
        authority,
        projectId,
        providerAvailability:
          options.providerAvailability ?? (await probe(repository.config.llm.tool)),
        log: line,
        signal: stop.signal,
        idleExitMs: options.idleExitMs ?? repository.config.knowledge_processing.idle_exit_ms,
        env: getInvocationEnv(),
        ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
        ...(options.leaseTermMs === undefined ? {} : { leaseTermMs: options.leaseTermMs }),
        ...(options.callLifetimeMs === undefined ? {} : { callLifetimeMs: options.callLifetimeMs }),
        ...(options.revalidateMs === undefined ? {} : { revalidateMs: options.revalidateMs }),
        ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
        ...(options.scratchParentDir === undefined
          ? {}
          : { scratchParentDir: options.scratchParentDir }),
      });
      line(
        `Worker finished [${report.outcome}] after ${report.callsMade} call(s) and ` +
          `${report.jobsSettled} settlement(s): ${report.detail}`
      );
      return report;
    } finally {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
    }
  } catch (err) {
    // A detached worker has no caller to fail. Everything it can say, it says
    // in its log.
    line(`The worker stopped early: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
