import {
  buildReconciliationPlan,
  type EffectiveProcessingConfiguration,
  type InterpretationAttemptRequest,
  retrievalAttemptRecord,
  validateProposal,
} from '@orcaops/core';
import {
  type PreparedInputCallResult,
  type ProviderProbeSnapshot,
  runPreparedInputCall,
} from '@orcaops/llm';
import {
  type InterpretationAttemptScheduleBinding,
  type InterpretationProcessingSchedule,
  type InterpretationQuality,
  type InterpretationUnitReceipt,
  uuidv7,
} from '@orcaops/storage';
import {
  claimProcessingJob,
  type DatabaseJson,
  openProjectDatabase,
  parkProcessingJob,
  pauseProcessing,
  type ProcessingJob,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  readAllProcessingJobAttempts,
  readInterpretationProgress,
  readProcessingJobAllowance,
  readProjectCandidateRevisionCompatibility,
  recordProcessingAttemptProcess,
  recoverProcessingAttempts,
  type RelatedKnowledgeRetrieval,
  releaseProcessingLease,
  renewProcessingLease,
  resolveProjectInterpretationSources,
  settleExhaustedProcessingJob,
  settleProcessingAttempt,
  settleProcessingCall,
  startProcessingAttempt,
  takeProcessingLease,
  unparkProcessingJobs,
} from '@orcaops/storage/history/database';

import { planJobAttempt, retainedSchedule } from './attempt-plan.js';
import {
  callLimitsFor,
  callResultIsLost,
  classifyCallFailure,
  LOCAL_PROVIDER_ESCALATION,
  localProviderWaitReason,
  RETRY_DELAY_CEILING_MS,
  retryDelayMs,
} from './call-outcome.js';
import {
  decideDispatch,
  restrictedScheduledFields,
  type RetrieveRelatedKnowledge,
  revalidateAuthorization,
} from './dispatch.js';
import {
  CALL_LIFETIME_MS,
  LEASE_HEARTBEAT_MS,
  LEASE_TERM_MS,
  mintWorkerOwnerId,
} from './ownership.js';
import { retainedProviderProcess, terminateRetainedProviderProcess } from './provider-process.js';
import {
  interpretationSourceInput,
  publishReconciliationPlanAndSettleAttempt,
} from './publication.js';
import { aggregateQuality, qualityFromValidation } from './quality.js';
import { ORIGIN_BOUND_WAIT_REASONS, parkedWaitReason, WORKER_PAUSE_ACTOR } from './wait-reasons.js';

/**
 * The background worker: one owner per project database, one paid call at a
 * time, and nothing sent until the grant, the configuration and the admission
 * rule have all been checked again for the job in hand.
 *
 * Every write names the lease generation, so a worker that lost ownership
 * changes nothing. A call whose provider was not observed to stop leaves the
 * attempt unsettled and the job unclaimable until its bounded lifetime has
 * elapsed, which is what stops a replacement paid call while the first may
 * still be spending.
 */

export type WorkerOutcome =
  | 'lease_held_by_other'
  | 'idle'
  | 'stopped'
  | 'lost_lease'
  | 'workload_paused';

export interface KnowledgeWorkerReport {
  outcome: WorkerOutcome;
  generation: number | null;
  jobsSettled: number;
  callsMade: number;
  /** Jobs this run refused before constructing a provider and left for later. */
  jobsParked: number;
  detail: string;
}

export interface KnowledgeWorkerOptions {
  authority: ProjectDatabaseAuthority;
  projectId: string;
  providerAvailability: ProviderProbeSnapshot;
  /** Where a line about what the worker did goes; the caller owns the sink. */
  log: (line: string) => void;
  /** Requests an orderly stop: the active call is cancelled and settled. */
  signal?: AbortSignal;
  idleExitMs: number;
  env?: NodeJS.ProcessEnv;
  /** Test seams. Production takes every default. */
  heartbeatMs?: number;
  leaseTermMs?: number;
  callLifetimeMs?: number;
  /** How often configuration and consent are re-read while a call is active. */
  revalidateMs?: number;
  killGraceMs?: number;
  scratchParentDir?: string;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  retrieve?: RetrieveRelatedKnowledge;
  renewLease?: (signal: AbortSignal) => Promise<void>;
  afterAttemptStart?: () => void | Promise<void>;
  beforePublication?: () => void | Promise<void>;
  onPublicationWait?: () => void;
  recordProviderProcess?: typeof recordProcessingAttemptProcess;
}

const REVALIDATE_MS = 2_000;

const instant = (clock: () => Date): string => clock().toISOString();
const after = (clock: () => Date, ms: number): string =>
  new Date(clock().getTime() + ms).toISOString();

const emptyQuality = (): InterpretationQuality => ({
  schema: 'orcaops.interpretation_quality/v1',
  outcome: 'empty',
  proposed: { statements: 0, alternatives: 0, corrections: 0, links: 0, uncertainties: 0 },
  accepted: { statements: 0, alternatives: 0, corrections: 0, links: 0, uncertainties: 0 },
  held_back: { statements: 0, alternatives: 0, corrections: 0, links: 0, uncertainties: 0 },
  rejected: { statements: 0, alternatives: 0, corrections: 0, links: 0, uncertainties: 0 },
  diagnostics: [],
  diagnostics_total: 0,
  diagnostics_omitted: 0,
});

function withProcessRegistrationFailure(
  call: PreparedInputCallResult,
  error: unknown
): PreparedInputCallResult {
  // A call that already failed keeps its own code: it decides retry, pause, or
  // terminal handling, and CANCELLED would retry a provider that broke no-tool mode.
  if (call.status === 'failed') {
    return {
      ...call,
      message: `${call.message} Its process could not be recorded either: ${describe(error)}`,
    };
  }
  return {
    status: 'failed',
    code: 'CANCELLED',
    message: `The provider call was cancelled because its process could not be recorded: ${describe(error)}`,
    provider: call.provider,
    providerStarted: true,
    terminationConfirmed: true,
    hardKilled: false,
    durationMs: call.durationMs,
    reportedModel: call.reportedModel,
    usage: call.usage,
    costUsd: call.costUsd,
    settings: call.settings,
    refusals: [],
  };
}

function scheduleCoverage(
  schedule: InterpretationProcessingSchedule,
  receipts: readonly InterpretationUnitReceipt[],
  completingUnitId?: string
) {
  const settledUnits = new Set([
    ...receipts.map((receipt) => receipt.unit_id),
    ...(completingUnitId === undefined ? [] : [completingUnitId]),
  ]);
  const settledSegments = new Set(
    receipts.flatMap((receipt) => receipt.primary_ranges.map((range) => range.segment_id))
  );
  if (completingUnitId !== undefined) {
    for (const segment of schedule.units.find((unit) => unit.unit_id === completingUnitId)
      ?.segments ?? [])
      if (segment.purpose === 'primary') settledSegments.add(segment.segment_id);
  }
  const primaryByField = new Map<string, string[]>();
  for (const unit of schedule.units) {
    for (const segment of unit.segments) {
      if (segment.purpose !== 'primary') continue;
      const field = segment.occurrence.field_path;
      const ids = primaryByField.get(field) ?? [];
      ids.push(segment.segment_id);
      primaryByField.set(field, ids);
    }
  }
  const fieldsProcessed: string[] = [];
  const fieldsUnfinished: string[] = [];
  for (const [field, segments] of primaryByField) {
    (segments.every((segment) => settledSegments.has(segment))
      ? fieldsProcessed
      : fieldsUnfinished
    ).push(field);
  }
  return {
    schedule_id: schedule.schedule_id,
    scheduled_units: schedule.units.length,
    settled_units: settledUnits.size,
    unfinished_unit_ids: schedule.units
      .filter((unit) => !settledUnits.has(unit.unit_id))
      .map((unit) => unit.unit_id),
    fields_processed: fieldsProcessed,
    fields_omitted: schedule.omissions.map((omission) => omission.field_path),
    fields_unfinished: fieldsUnfinished,
  };
}

/**
 * The clock is sampled once for both ends. Sampling it twice makes the term a
 * millisecond longer than the ceiling whenever time passes between the two
 * reads, and the store refuses a lease held for longer than its caller allows —
 * which would look like losing ownership rather than the arithmetic slip it is.
 */
function leaseWindow(clock: () => Date, termMs: number): { now: string; expiresAt: string } {
  const now = clock().getTime();
  return { now: new Date(now).toISOString(), expiresAt: new Date(now + termMs).toISOString() };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function runKnowledgeWorker(
  options: KnowledgeWorkerOptions
): Promise<KnowledgeWorkerReport> {
  const clock = options.now ?? (() => new Date());
  const heartbeatMs = options.heartbeatMs ?? LEASE_HEARTBEAT_MS;
  const leaseTermMs = options.leaseTermMs ?? LEASE_TERM_MS;
  const callLifetimeMs = options.callLifetimeMs ?? CALL_LIFETIME_MS;
  const ownerId = mintWorkerOwnerId(clock().getTime());
  const handle = await openProjectDatabase({ authority: options.authority, mode: 'writer' });

  const take = await takeProcessingLease(handle, {
    ownerId,
    ...leaseWindow(clock, leaseTermMs),
    maxTermMs: leaseTermMs,
  });
  if (take.outcome === 'held_by_other') {
    handle.close();
    return {
      outcome: 'lease_held_by_other',
      generation: take.lease.ownerGeneration,
      jobsSettled: 0,
      callsMade: 0,
      jobsParked: 0,
      detail:
        `Another worker holds the processing lease (generation ${take.lease.ownerGeneration}, ` +
        `until ${take.lease.expiresAt}). This one does nothing and exits.`,
    };
  }
  const generation = take.lease.ownerGeneration;
  options.log(`Took the processing lease as generation ${generation}.`);

  let heartbeatHandle: ProjectDatabase;
  try {
    heartbeatHandle = await openProjectDatabase({ authority: options.authority, mode: 'writer' });
  } catch (cause) {
    await releaseProcessingLease(handle, { ownerId, generation }).catch(() => {});
    handle.close();
    throw cause;
  }

  const session = new WorkerSession({
    ...options,
    clock,
    handle,
    heartbeatHandle,
    generation,
    ownerId,
    heartbeatMs,
    leaseTermMs,
    callLifetimeMs,
  });
  try {
    return await session.run();
  } finally {
    await session.finish();
  }
}

interface SessionOptions extends KnowledgeWorkerOptions {
  clock: () => Date;
  handle: ProjectDatabase;
  heartbeatHandle: ProjectDatabase;
  generation: number;
  ownerId: string;
  heartbeatMs: number;
  leaseTermMs: number;
  callLifetimeMs: number;
}

class WorkerSession {
  readonly #options: SessionOptions;
  readonly #handle: ProjectDatabase;
  readonly #heartbeatHandle: ProjectDatabase;
  readonly #generation: number;
  #heartbeat: NodeJS.Timeout | null = null;
  #heartbeatAbort: AbortController | null = null;
  #heartbeatRenewal: Promise<void> | null = null;
  #lostLease = false;
  #jobsSettled = 0;
  #callsMade = 0;
  #jobsParked = 0;
  /**
   * Jobs this run returned to the queue with nothing recorded against them.
   * Claiming holds those back by its own mechanism, so meeting one twice means
   * that mechanism did not hold and the run ends rather than spinning on it.
   */
  readonly #returnedUnparked = new Set<string>();
  /** Set when the active call must stop: shutdown, lost lease, or a withdrawn authorization. */
  #cancelCall: AbortController | null = null;
  /** Whether this call's watchdog has already reported that it could not read. */
  #revalidationFailed = false;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#handle = options.handle;
    this.#heartbeatHandle = options.heartbeatHandle;
    this.#generation = options.generation;
  }

  get #clock(): () => Date {
    return this.#options.clock;
  }

  #log(line: string): void {
    this.#options.log(line);
  }

  #stopRequested(): boolean {
    return this.#lostLease || this.#options.signal?.aborted === true;
  }

  async run(): Promise<KnowledgeWorkerReport> {
    this.#startHeartbeat();
    await this.#recover();
    await this.#reexamineOriginBound();

    let idled = false;
    // Keep the horizon fixed for one idle spell so a moving retry cannot keep
    // renewing this worker's lease indefinitely.
    let retryWaitDeadline: number | null = null;
    for (;;) {
      if (this.#stopRequested()) return this.#report(this.#lostLease ? 'lost_lease' : 'stopped');
      const claim = await claimProcessingJob(this.#handle, {
        generation: this.#generation,
        now: instant(this.#clock),
      });
      if (claim.outcome === 'nothing_claimable') {
        const continuingRetryWait = retryWaitDeadline !== null;
        let retryWait =
          retryWaitDeadline === null ? null : this.#scheduledRetryWait(claim, retryWaitDeadline);
        if (continuingRetryWait && retryWait === null) {
          retryWaitDeadline = null;
          idled = true;
        }
        if (!continuingRetryWait && retryWaitDeadline === null && !idled) {
          retryWaitDeadline = this.#clock().getTime() + RETRY_DELAY_CEILING_MS;
          retryWait = this.#scheduledRetryWait(claim, retryWaitDeadline);
          if (retryWait === null) retryWaitDeadline = null;
        }
        if (retryWait !== null) {
          await (this.#options.sleep ?? sleep)(
            Math.min(retryWait, this.#options.idleExitMs),
            this.#options.signal
          );
          continue;
        }
        if (idled) {
          return this.#report(
            'idle',
            `Nothing is claimable (${claim.reason}); the worker exits after its idle interval.`
          );
        }
        idled = true;
        await (this.#options.sleep ?? sleep)(this.#options.idleExitMs, this.#options.signal);
        continue;
      }
      idled = false;
      retryWaitDeadline = null;
      const done = await this.#processJob(claim.job);
      if (done !== null) return done;
    }
  }

  #scheduledRetryWait(
    claim: Extract<
      Awaited<ReturnType<typeof claimProcessingJob>>,
      { outcome: 'nothing_claimable' }
    >,
    deadline: number
  ): number | null {
    if (claim.reason !== 'waiting' || claim.nextRetry == null) return null;
    const nextRetry = Date.parse(claim.nextRetry.retryAt);
    if (nextRetry > deadline) return null;
    // The retry can come due between the claim and this reading of the clock. That is a wait of
    // nothing, and the next claim takes the job; it is not a reason to exit.
    return Math.max(nextRetry - this.#clock().getTime(), 0);
  }

  /**
   * Settle what a lost owner left and return its abandoned claims, terminating
   * any provider it spawned first. An attempt still inside its call's bounded
   * lifetime is left exactly as it is: its job stays unclaimable, so no
   * replacement paid call can start while the first may still be running.
   */
  async #recover(): Promise<void> {
    const recovery = await this.#recoverOnce();
    for (const settled of recovery.settled) {
      const termination = await terminateRetainedProviderProcess(settled.attempt.process);
      this.#log(
        `Recovered attempt ${settled.attempt.attemptId} of job ${settled.job.jobId} as unknown; ` +
          `its provider process is ${termination.outcome}.`
      );
    }
    const confirmedGone: string[] = [];
    for (const waiting of recovery.waiting) {
      const termination = await terminateRetainedProviderProcess(waiting.process);
      if (termination.outcome === 'gone') confirmedGone.push(waiting.attemptId);
      // Which of the two cases this is decides what could ever shorten the wait:
      // an attempt that recorded no process was lost between the spawn and the
      // write, so nothing observed says whether a call is running, and only the
      // lifetime can end it.
      this.#log(
        `Attempt ${waiting.attemptId} of job ${waiting.jobId} was inside its call's lifetime ` +
          `until ${waiting.eligibleAt}; ` +
          (termination.outcome === 'nothing_recorded'
            ? 'it recorded no provider process, so nothing observed says whether a call is ' +
              'running and only its lifetime ends the wait. '
            : `its provider process is ${termination.outcome}. `) +
          `No replacement call is started for it.`
      );
    }
    if (recovery.reclaimed.length > 0) {
      this.#log(`Returned ${recovery.reclaimed.length} abandoned claim(s) to the queue.`);
    }
    if (confirmedGone.length === 0) return;
    // Watching the provider group go is better evidence than the lifetime bound,
    // and the job holds the project's only running slot until its attempt is
    // settled — so these are settled now rather than waiting the bound out.
    const settled = await this.#recoverOnce(confirmedGone);
    for (const done of settled.settled) {
      this.#log(
        `Attempt ${done.attempt.attemptId} of job ${done.job.jobId} settled as unknown: its ` +
          `provider process was confirmed gone, so the call cannot still be running.`
      );
    }
  }

  #recoverOnce(confirmedGone?: readonly string[]): ReturnType<typeof recoverProcessingAttempts> {
    return recoverProcessingAttempts(this.#handle, {
      generation: this.#generation,
      now: instant(this.#clock),
      callLifetimeMs: this.#options.callLifetimeMs,
      waitReason: 'call_result_unknown',
      retryAt: after(this.#clock, retryDelayMs(1)),
      ...(confirmedGone === undefined ? {} : { confirmedGone }),
    });
  }

  async #processJob(job: ProcessingJob): Promise<KnowledgeWorkerReport | null> {
    const decision = await decideDispatch({
      handle: this.#handle,
      job,
      projectId: this.#options.projectId,
      providerAvailability: this.#options.providerAvailability,
      ...(this.#options.retrieve === undefined ? {} : { retrieve: this.#options.retrieve }),
    });
    if (decision.outcome === 'refused') return this.#park(job, decision);
    if (decision.outcome === 'attempts_exhausted')
      return this.#finishExhausted(job, decision.configuration);

    const { configuration, source } = decision;
    const retained = readAllProcessingJobAttempts(this.#handle, job.jobId);
    const { attemptsMade, attemptsAllowed } = readProcessingJobAllowance(
      this.#handle,
      job.jobId,
      configuration.maxAttempts
    );
    const retainedDefinition = retainedSchedule(retained);
    if (retainedDefinition.ok && retainedDefinition.schedule !== null) {
      const restricted = restrictedScheduledFields(
        this.#handle,
        retainedDefinition.schedule.units.flatMap((unit) => unit.segments)
      );
      if (restricted.length > 0)
        return this.#park(job, {
          outcome: 'refused',
          waitReason: 'source_access_changed',
          detail:
            `A previously scheduled field is now access restricted (${restricted.join(', ')}). ` +
            `The frozen unit is not modified or sent.`,
        });
    }
    let progress: ReturnType<typeof readInterpretationProgress> = null;
    if (retained.length > 0) {
      try {
        progress = readInterpretationProgress(this.#handle, job.jobId);
      } catch (error) {
        return this.#park(job, {
          outcome: 'refused',
          waitReason: 'schedule_integrity_failure',
          detail: `Retained interpretation progress is not trustworthy: ${describe(error)}`,
        });
      }
    }
    const plan = planJobAttempt({
      source,
      projectId: this.#options.projectId,
      configuration,
      attemptsRemaining: Math.max(0, attemptsAllowed - attemptsMade),
      retained,
      completedUnitIds: progress?.receipts.map((receipt) => receipt.unit_id) ?? [],
      retrieval: decision.retrieval,
    });
    if (plan.outcome === 'attempts_exhausted') return this.#finishExhausted(job, configuration);
    if (plan.outcome !== 'ready' && plan.outcome !== 'empty') {
      return this.#park(job, {
        outcome: 'refused',
        waitReason: plan.outcome,
        detail: plan.detail,
      });
    }
    if (plan.outcome === 'empty') {
      if (plan.schedule.units.length !== 0)
        return this.#park(job, {
          outcome: 'refused',
          waitReason: 'schedule_integrity_failure',
          detail: 'Every scheduled unit has a receipt but the processing job is not completed.',
        });
      return this.#completeWithoutCall(job, decision, plan.schedule, {
        outcome: 'nothing_to_interpret',
        detail: `The ${source.eventType} event holds no non-empty eligible authored field.`,
      });
    }
    const request = plan.request;
    const unit = plan.schedule.units[plan.unitIndex]!;
    const unitProgress = {
      scheduleId: plan.schedule.schedule_id,
      unitId: unit.unit_id,
      index: plan.unitIndex,
      count: plan.schedule.units.length,
    };

    const started = await this.#startAttempt(
      job,
      decision,
      request,
      decision.retrieval!,
      plan.schedule,
      plan.scheduleAttemptId,
      unitProgress
    );
    if (started === null) return null;
    await this.#options.afterAttemptStart?.();
    const preSpawn =
      this.#restrictedUnit(request) ?? (await this.#revalidateFrozenAuthorization(job, decision));
    if (preSpawn !== null) {
      const finishedAt = instant(this.#clock);
      await settleProcessingCall(this.#handle, {
        generation: this.#generation,
        usageId: started.usageId,
        settledAt: finishedAt,
        result: { kind: 'released' },
      });
      await settleProcessingAttempt(this.#handle, {
        generation: this.#generation,
        jobId: job.jobId,
        attemptId: started.attemptId,
        finishedAt,
        usage: null,
        outcome: {
          kind: 'retryable_failure',
          waitReason: preSpawn.waitReason,
          retryAt: after(this.#clock, retryDelayMs(attemptsMade + 1)),
          detail: json({
            unit: unitProgress,
            manifest_sha256: request.manifest.manifest_sha256,
            provider_started: false,
            withdrawn: { wait_reason: preSpawn.waitReason, detail: preSpawn.detail },
          }),
        },
      });
      this.#jobsSettled += 1;
      this.#log(
        `Attempt ${started.attemptId} was refused before provider spawn ` +
          `[${preSpawn.waitReason}]: ${preSpawn.detail}`
      );
      return null;
    }

    this.#callsMade += 1;
    const call = await this.#callProvider({
      job,
      configuration,
      request,
      attemptId: started.attemptId,
      permission: decision.permission,
    });
    try {
      await this.#settle({
        job,
        decision,
        request,
        schedule: plan.schedule,
        unit: unitProgress,
        priorReceipts: progress?.receipts ?? [],
        attempt: started,
        call,
        attemptsMade,
      });
      if (!this.#lostLease) this.#jobsSettled += 1;
    } catch (err) {
      // An attempt that would not settle stays open on purpose: its job is not
      // claimable again until recovery has waited out the call's lifetime, so
      // the failure cannot become a second paid call.
      this.#log(
        `Attempt ${started.attemptId} of job ${job.jobId} did not settle: ${describe(err)} ` +
          `It is left open, and recovery decides it.`
      );
      return this.#report('stopped', `A settlement failed: ${describe(err)}`);
    }
    if (this.#stopRequested()) return this.#report(this.#lostLease ? 'lost_lease' : 'stopped');
    if (this.#paused) return this.#report('workload_paused', this.#pausedDetail);
    return null;
  }

  async #finishExhausted(
    job: ProcessingJob,
    configuration: EffectiveProcessingConfiguration
  ): Promise<KnowledgeWorkerReport | null> {
    try {
      const exhausted = await settleExhaustedProcessingJob(this.#handle, {
        generation: this.#generation,
        jobId: job.jobId,
        maxAttempts: configuration.maxAttempts,
        at: instant(this.#clock),
      });
      this.#jobsSettled += 1;
      this.#log(
        `Job ${job.jobId} has spent its allowance of ${exhausted.maxAttempts} attempt(s) and is ` +
          `finished as a terminal failure.`
      );
    } catch (err) {
      this.#log(`Job ${job.jobId} could not be finished: ${describe(err)}`);
      return this.#report('stopped', `An exhausted job could not be finished: ${describe(err)}`);
    }
    return null;
  }

  #paused = false;
  #pausedDetail = '';
  /** The local provider condition this run has met in a row, and how often. */
  #consecutiveLocal: { code: string; count: number } | null = null;

  /**
   * Give a refused job back and go on to the next one. A refusal that no clock
   * resolves is recorded as the job's wait reason, so the job waits instead of
   * being claimed first again on every run and starving everything behind it.
   * Nothing is attempted and none of its allowance is spent.
   */
  async #park(
    job: ProcessingJob,
    refusal: Extract<Awaited<ReturnType<typeof decideDispatch>>, { outcome: 'refused' }>
  ): Promise<KnowledgeWorkerReport | null> {
    const waitReason = parkedWaitReason(refusal.waitReason);
    if (waitReason === null && this.#returnedUnparked.has(job.jobId)) {
      return this.#report(
        'stopped',
        `Job ${job.jobId} was claimed again after being returned unparked [${refusal.waitReason}]; ` +
          `the run ends rather than claiming it a third time.`
      );
    }
    if (waitReason === null) this.#returnedUnparked.add(job.jobId);
    try {
      await parkProcessingJob(this.#handle, {
        generation: this.#generation,
        jobId: job.jobId,
        waitReason,
        now: instant(this.#clock),
      });
      this.#jobsParked += 1;
      this.#log(
        `Job ${job.jobId} is not dispatched [${refusal.waitReason}]: ${refusal.detail} ` +
          `No provider was constructed, and it is ` +
          `${waitReason === null ? 'returned to the queue' : `parked on ${waitReason}`}.`
      );
    } catch (err) {
      this.#log(`Job ${job.jobId} could not be parked: ${describe(err)}`);
      return this.#report('stopped', `A refused job could not be parked: ${describe(err)}`);
    }
    // The pause holds the whole queue, not this job, so there is nothing else
    // to claim and the run ends here.
    if (refusal.waitReason === 'project_paused')
      return this.#report('workload_paused', refusal.detail);
    return null;
  }

  /**
   * Once per run, and only after recovery: make every job parked on a reason
   * something outside it can resolve claimable again, so a worktree that was
   * re-enabled or re-consented is processed on the next wake-up rather than
   * waiting for an operator's retry. Each such job then costs one dispatch
   * decision and, if it is still refused, is parked again.
   */
  async #reexamineOriginBound(): Promise<void> {
    try {
      const freed = await unparkProcessingJobs(this.#handle, {
        generation: this.#generation,
        waitReasons: ORIGIN_BOUND_WAIT_REASONS,
        now: instant(this.#clock),
      });
      if (freed.length > 0)
        this.#log(
          `Re-examining ${freed.length} job(s) parked on a configuration or consent reason.`
        );
    } catch (err) {
      this.#log(`Parked jobs could not be re-examined: ${describe(err)}`);
    }
  }

  async #startAttempt(
    job: ProcessingJob,
    decision: Extract<Awaited<ReturnType<typeof decideDispatch>>, { outcome: 'ready' }>,
    request: InterpretationAttemptRequest,
    retrieval: RelatedKnowledgeRetrieval,
    schedule: InterpretationProcessingSchedule,
    scheduleAttemptId: string | null,
    unit: { scheduleId: string; unitId: string; index: number; count: number }
  ): Promise<{ attemptId: string; usageId: string } | null> {
    const { configuration, grantId, confirmation, permission } = decision;
    const attemptId = uuidv7();
    const usageId = uuidv7();
    const scheduleBinding: InterpretationAttemptScheduleBinding = {
      schedule: scheduleAttemptId === null ? schedule : null,
      schedule_attempt_id: scheduleAttemptId ?? attemptId,
      unit: {
        schedule_id: unit.scheduleId,
        unit_id: unit.unitId,
        index: unit.index,
        count: unit.count,
      },
    };
    const start = await startProcessingAttempt(this.#handle, {
      generation: this.#generation,
      jobId: job.jobId,
      attemptId,
      usageId,
      startedAt: instant(this.#clock),
      maxAttempts: configuration.maxAttempts,
      configurationIdentity: configuration.configurationIdentity,
      confirmationId: confirmation?.confirmationId ?? null,
      configuration: json({
        provider: configuration.provider,
        model: { id: configuration.model.id, selection: configuration.model.selection },
        effort: configuration.effort.value,
        limits: configuration.limits,
        timeout_ms: configuration.timeoutMs,
        max_attempts: configuration.maxAttempts,
        configuration_source: configuration.source,
        manifest_sha256: request.manifest.manifest_sha256,
        prompt_version: request.manifest.prompt_version,
        proposal_schema_version: request.manifest.proposal_schema_version,
        processor_contract: request.manifest.processor_contract,
        sources: request.manifest.sources.map((source) => ({
          source_id: source.source_id,
          occurrence: source.occurrence,
        })),
        schedule_binding: scheduleBinding,
        permission,
        // What was looked for beside what was found, so a retained attempt
        // says which bounds its related knowledge was read under.
        retrieval: retrievalAttemptRecord(retrieval),
      }),
      grantId,
      ...callLimitsFor(configuration.limits),
    });
    if (start.outcome === 'attempts_exhausted') {
      this.#log(
        `Job ${job.jobId} has spent its allowance of ${start.maxAttempts} attempt(s) and is ` +
          `finished as a terminal failure.`
      );
      return null;
    }
    if (start.outcome === 'refused') {
      this.#log(
        `Job ${job.jobId} is parked on ${start.limit} until ${start.freesUpAt}; no call was made ` +
          `and none of its allowance was spent.`
      );
      return null;
    }
    return { attemptId, usageId };
  }

  async #callProvider(input: {
    job: ProcessingJob;
    configuration: EffectiveProcessingConfiguration;
    request: InterpretationAttemptRequest;
    attemptId: string;
    permission: Extract<
      Awaited<ReturnType<typeof decideDispatch>>,
      { outcome: 'ready' }
    >['permission'];
  }): Promise<PreparedInputCallResult> {
    const { configuration, request, attemptId } = input;
    const controller = new AbortController();
    this.#cancelCall = controller;
    this.#revalidationFailed = false;
    if (this.#stopRequested()) controller.abort();
    const stopOnShutdown = (): void => controller.abort();
    this.#options.signal?.addEventListener('abort', stopOnShutdown, { once: true });

    let processRecorded: Promise<unknown> = Promise.resolve();
    let processRegistrationFailed = false;
    let processRegistrationError: unknown;
    const watchdog = setInterval(() => {
      void this.#revalidate(input.job, input.permission, request, controller);
    }, this.#options.revalidateMs ?? REVALIDATE_MS);
    try {
      const call = await runPreparedInputCall({
        ...configuration.callRequest,
        preparedInput: request.parts.preparedInput,
        instructions: request.parts.instructions,
        ...(request.parts.systemPrompt === undefined
          ? {}
          : { systemPrompt: request.parts.systemPrompt }),
        outputSchema: request.parts.outputSchema ?? null,
        maxInputBytes: configuration.limits.max_input_bytes,
        maxOutputBytes: configuration.limits.max_output_bytes,
        timeoutMs: configuration.timeoutMs,
        signal: controller.signal,
        ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
        ...(this.#options.killGraceMs === undefined
          ? {}
          : { killGraceMs: this.#options.killGraceMs }),
        ...(this.#options.scratchParentDir === undefined
          ? {}
          : { scratchParentDir: this.#options.scratchParentDir }),
        onProviderProcess: (spawned) => {
          // Recorded as soon as it is known, so an owner that takes over after
          // this process dies can terminate what this call left running.
          processRecorded = (this.#options.recordProviderProcess ?? recordProcessingAttemptProcess)(
            this.#handle,
            {
              generation: this.#generation,
              attemptId,
              process: retainedProviderProcess({
                process: spawned,
                provider: configuration.provider.id,
                spawnedAt: instant(this.#clock),
              }),
            }
          ).catch((err: unknown) => {
            processRegistrationFailed = true;
            processRegistrationError = err;
            this.#log(
              `The provider process of attempt ${attemptId} was not recorded: ${describe(err)}`
            );
            controller.abort();
          });
        },
      });
      await processRecorded;
      return !processRegistrationFailed
        ? call
        : withProcessRegistrationFailure(call, processRegistrationError);
    } finally {
      clearInterval(watchdog);
      this.#options.signal?.removeEventListener('abort', stopOnShutdown);
      this.#cancelCall = null;
      await processRecorded;
    }
  }

  /**
   * Configuration and consent while the call is active. A disablement, a
   * changed limit or a revoked grant stops it as promptly as cancellation
   * reaches the provider; already incurred spend is still recorded.
   */
  async #revalidate(
    job: ProcessingJob,
    permission: Extract<
      Awaited<ReturnType<typeof decideDispatch>>,
      { outcome: 'ready' }
    >['permission'],
    request: InterpretationAttemptRequest,
    controller: AbortController
  ): Promise<void> {
    if (controller.signal.aborted) return;
    try {
      const restricted = this.#restrictedUnit(request);
      if (restricted !== null) {
        this.#log(`Cancelling the active call for job ${job.jobId}: ${restricted.detail}`);
        controller.abort();
        return;
      }
      const decision = await revalidateAuthorization({
        handle: this.#handle,
        job,
        permission,
        providerAvailability: this.#options.providerAvailability,
      });
      if ('waitReason' in decision) {
        this.#log(
          `Cancelling the active call for job ${job.jobId}: ${decision.waitReason} — ${decision.detail}`
        );
        controller.abort();
      }
    } catch (err) {
      // Deliberately failing open: this call was authorized at dispatch and is
      // bounded by its own deadline, so cancelling it over a transient read
      // error would throw away spend that is already incurred for nothing. The
      // next dispatch reads both again and refuses then. Said once per call,
      // not every two seconds.
      if (!this.#revalidationFailed) {
        this.#revalidationFailed = true;
        this.#log(
          `Re-reading configuration and consent failed; the call is left to its deadline: ` +
            `${describe(err)}`
        );
      }
    }
  }

  #restrictedUnit(
    request: InterpretationAttemptRequest
  ): { waitReason: string; detail: string } | null {
    const fields = restrictedScheduledFields(this.#handle, request.manifest.segments);
    return fields.length === 0
      ? null
      : {
          waitReason: 'source_access_changed',
          detail:
            `Access changed for scheduled field(s) ${fields.join(', ')}. ` +
            `The frozen unit is not sent or published.`,
        };
  }

  /**
   * Whether the frozen authorization still holds. Null means it does;
   * anything else is why it does not.
   *
   * A read that fails is treated as a refusal rather than as permission: the
   * call is already paid for, and publishing under an authorization this worker
   * could not confirm is the one thing settlement must not do. The watchdog
   * during the call fails open for the opposite reason — there, cancelling
   * would throw away spend for a transient read error.
   */
  async #revalidateFrozenAuthorization(
    job: ProcessingJob,
    decision: Extract<Awaited<ReturnType<typeof decideDispatch>>, { outcome: 'ready' }>
  ): Promise<{ waitReason: string; detail: string } | null> {
    try {
      const authorization = await revalidateAuthorization({
        handle: this.#handle,
        job,
        permission: decision.permission,
        providerAvailability: this.#options.providerAvailability,
      });
      return 'waitReason' in authorization
        ? { waitReason: authorization.waitReason, detail: authorization.detail }
        : null;
    } catch (err) {
      return {
        waitReason: 'authorization_unreadable',
        detail:
          `The configuration and grant this call ran under could not be read again at ` +
          `settlement: ${describe(err)}`,
      };
    }
  }

  async #settle(input: {
    job: ProcessingJob;
    decision: Extract<Awaited<ReturnType<typeof decideDispatch>>, { outcome: 'ready' }>;
    request: InterpretationAttemptRequest;
    schedule: InterpretationProcessingSchedule;
    unit: { scheduleId: string; unitId: string; index: number; count: number };
    priorReceipts: readonly InterpretationUnitReceipt[];
    attempt: { attemptId: string; usageId: string };
    call: PreparedInputCallResult;
    attemptsMade: number;
  }): Promise<void> {
    const { job, request, unit, attempt, call } = input;
    if (this.#lostLease) {
      // A superseded owner must not report what its call did. Recovery under
      // the new generation settles the attempt as unknown and keeps its whole
      // conservative hold, which loses the real usage and is the safe direction.
      this.#log(
        `Attempt ${attempt.attemptId} is left unsettled: this worker no longer owns the lease.`
      );
      return;
    }
    const finishedAt = instant(this.#clock);
    // A provider that reported nothing leaves usage unknown. Recording zero
    // would turn an unknown spend into a free one.
    const usage: DatabaseJson =
      call.usage === null && call.costUsd === null
        ? null
        : json({
            tokens: call.usage,
            cost_usd: call.costUsd,
            reported_model: call.reportedModel,
            duration_ms: call.durationMs,
          });

    const lost = call.status === 'failed' && callResultIsLost(call);
    // A failure here is not swallowed: a reservation stuck `reserved` beside an
    // attempt settled as succeeded is a hold nothing ever returns, and recovery
    // only looks at unsettled attempts. Throwing leaves the attempt open, which
    // is exactly what recovery can see and decide.
    await settleProcessingCall(this.#handle, {
      generation: this.#generation,
      usageId: attempt.usageId,
      settledAt: finishedAt,
      result: lost
        ? { kind: 'unknown' }
        : call.status === 'failed' && !call.providerStarted
          ? { kind: 'released' }
          : { kind: 'reported', costUsd: call.costUsd, usage },
    });

    // The grant is judged again now, as it was at dispatch: a job is never
    // completed under a grant that no longer covers it. The spend above is
    // real either way and stays recorded.
    //
    // A lost call is exempt, because its own rule is stricter: it publishes
    // nothing whatever the grant says, and its job must stay unclaimable for
    // the whole call lifetime so no replacement paid call starts while the
    // first may still be spending. A withdrawal cannot shorten that, and the
    // next dispatch judges the grant again before any call.
    const authorization = lost
      ? null
      : (this.#restrictedUnit(request) ??
        (await this.#revalidateFrozenAuthorization(input.job, input.decision)));
    if (authorization !== null) {
      await settleProcessingAttempt(this.#handle, {
        generation: this.#generation,
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        finishedAt,
        usage,
        outcome: {
          kind: 'retryable_failure',
          waitReason: authorization.waitReason,
          retryAt: after(this.#clock, retryDelayMs(input.attemptsMade + 1)),
          // No reconciliation plan is retained: what the provider answered was
          // prepared under an authorization that no longer holds, so nothing is
          // carried forward for a later dispatch to publish.
          detail: json({
            unit,
            manifest_sha256: request.manifest.manifest_sha256,
            withdrawn: { wait_reason: authorization.waitReason, detail: authorization.detail },
            call: call.status === 'failed' ? { code: call.code, message: call.message } : null,
          }),
        },
      });
      this.#log(
        `Attempt ${attempt.attemptId} of job ${job.jobId} is not published ` +
          `[${authorization.waitReason}]: ${authorization.detail} The call's spend is recorded ` +
          `and the job is left for a later dispatch to judge.`
      );
      return;
    }

    const outcome = await this.#plannedOutcome({ ...input, lost, finishedAt, usage });
    if (outcome.settlement !== null)
      await settleProcessingAttempt(this.#handle, {
        generation: this.#generation,
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        finishedAt,
        usage,
        outcome: outcome.settlement,
      });
    this.#log(
      `Attempt ${attempt.attemptId} of job ${job.jobId} settled as ` +
        `${outcome.settlement?.kind ?? (unit.index + 1 === unit.count ? 'succeeded' : 'retryable_failure')} ` +
        `(unit ${unit.index + 1} of ${unit.count}, manifest ` +
        `${request.manifest.manifest_sha256.slice(0, 12)}): ${outcome.detail}`
    );
    if (outcome.pauseReason !== null) await this.#pauseWorkload(outcome.pauseReason);
  }

  async #plannedOutcome(input: {
    job: ProcessingJob;
    decision: Extract<Awaited<ReturnType<typeof decideDispatch>>, { outcome: 'ready' }>;
    request: InterpretationAttemptRequest;
    schedule: InterpretationProcessingSchedule;
    unit: { scheduleId: string; unitId: string; index: number; count: number };
    priorReceipts: readonly InterpretationUnitReceipt[];
    call: PreparedInputCallResult;
    attempt: { attemptId: string; usageId: string };
    usage: DatabaseJson;
    attemptsMade: number;
    lost: boolean;
    finishedAt: string;
  }): Promise<{
    settlement: Parameters<typeof settleProcessingAttempt>[1]['outcome'] | null;
    detail: string;
    pauseReason: string | null;
  }> {
    const { request, unit, call, attemptsMade, lost } = input;
    const retryAt = after(this.#clock, retryDelayMs(attemptsMade + 1));
    const priorAggregate = aggregateQuality(input.priorReceipts.map((receipt) => receipt.quality));
    const retainedProgress = {
      aggregate_quality: priorAggregate.quality,
      unit_outcomes: priorAggregate.unit_outcomes,
      coverage: scheduleCoverage(input.schedule, input.priorReceipts),
    };
    const versions = {
      processor_contract: request.manifest.processor_contract,
      prompt_version: request.manifest.prompt_version,
      proposal_schema_version: request.manifest.proposal_schema_version,
      ...(call.status === 'completed' && call.jsonRepair !== undefined
        ? { json_repair: { ...call.jsonRepair, repairedBody: call.body } }
        : {}),
    };

    if (call.status === 'failed') {
      const failureClass = classifyCallFailure(call.code);
      const detail = json({
        unit,
        manifest_sha256: request.manifest.manifest_sha256,
        ...versions,
        call: { code: call.code, message: call.message },
        ...retainedProgress,
      });
      if (lost) {
        return {
          settlement: {
            kind: 'unknown',
            waitReason: 'call_result_unknown',
            retryAt: after(this.#clock, this.#options.callLifetimeMs),
            detail,
          },
          detail: `${call.code}: the provider was not observed to stop, so the result is unknown.`,
          pauseReason: null,
        };
      }
      if (failureClass === 'terminal') {
        this.#consecutiveLocal = null;
        return {
          settlement: { kind: 'terminal_failure', result: detail, detail },
          detail: `${call.code}: ${call.message}`,
          pauseReason: null,
        };
      }
      if (failureClass === 'local_provider') {
        const repeated = this.#countLocalCondition(call.code);
        return {
          settlement: {
            kind: 'retryable_failure',
            waitReason: localProviderWaitReason(call.code),
            retryAt,
            detail,
          },
          detail: `${call.code}: ${call.message}`,
          // One of these is a moment on this machine, not a project-wide fact.
          // The same one ending three attempts in a row is no longer a moment.
          pauseReason:
            repeated < LOCAL_PROVIDER_ESCALATION
              ? null
              : `${call.code} ended ${repeated} attempts in a row on this machine: ` +
                `${call.message} Check the provider this worktree names, its version and the ` +
                `temporary directory the call runs in.`,
        };
      }
      this.#consecutiveLocal = null;
      return {
        settlement: {
          kind: 'retryable_failure',
          waitReason: failureClass === 'pause_workload' ? 'no_tool_guarantee' : 'provider_failed',
          retryAt,
          detail,
        },
        detail: `${call.code}: ${call.message}`,
        pauseReason: failureClass === 'pause_workload' ? `${call.code}: ${call.message}` : null,
      };
    }
    this.#consecutiveLocal = null;

    let answer: unknown;
    try {
      answer = JSON.parse(call.body);
    } catch (err) {
      const detail = json({ unit, ...versions, error: describe(err), ...retainedProgress });
      return {
        settlement: { kind: 'terminal_failure', result: detail, detail },
        detail: `The answer is not JSON: ${describe(err)}`,
        pauseReason: null,
      };
    }
    const validation = validateProposal({ manifest: request.manifest, answer });
    if (validation.outcome === 'rejected') {
      const failures = validation.failures.map((failure) => ({
        rule: failure.rule,
        detail: failure.detail,
      }));
      const detail = json({
        unit,
        manifest_sha256: request.manifest.manifest_sha256,
        ...versions,
        failures,
        ...retainedProgress,
      });
      return {
        settlement: { kind: 'terminal_failure', result: detail, detail },
        detail: `The proposal was refused: ${failures.map((f) => f.rule).join(', ')}.`,
        pauseReason: null,
      };
    }

    let aliases: ReturnType<typeof resolveProjectInterpretationSources>;
    try {
      aliases = resolveProjectInterpretationSources(
        this.#handle,
        interpretationSourceInput(request.manifest, input.decision.source)
      );
    } catch (error) {
      const detail = json({
        unit,
        manifest_sha256: request.manifest.manifest_sha256,
        ...versions,
        source_preflight_refused: describe(error),
        ...retainedProgress,
      });
      return {
        settlement: { kind: 'terminal_failure', result: detail, detail },
        detail: `The unit sources were refused before reconciliation: ${describe(error)}`,
        pauseReason: null,
      };
    }
    const sourceAliases = aliases.map(({ requestedSourceId, sourceId }) => ({
      requestedSourceId,
      sourceId,
    }));
    const reconciliationInput = {
      manifest: request.manifest,
      validated: validation.validated,
      source_aliases: sourceAliases,
      source_recorded_at: input.decision.source.recordedAt,
    };
    const provisional = buildReconciliationPlan(reconciliationInput);
    const candidateState = provisional.records.flatMap((record) => {
      if (
        record.kind !== 'requirement_revision' &&
        record.kind !== 'decision_revision' &&
        record.kind !== 'claim_revision'
      )
        return [];
      const resolved = readProjectCandidateRevisionCompatibility(this.#handle, {
        kind:
          record.kind === 'requirement_revision'
            ? 'requirement'
            : record.kind === 'decision_revision'
              ? 'decision'
              : 'claim',
        ...(record.kind === 'requirement_revision' ? { identity: record.identity } : {}),
        record: record.record,
      });
      return resolved.status === 'available'
        ? []
        : [{ target: resolved.target, status: resolved.status }];
    });
    const reconciliation = buildReconciliationPlan({
      ...reconciliationInput,
      candidate_state: candidateState,
    });
    const quality = qualityFromValidation({
      manifest: request.manifest,
      answer,
      validation,
      reconciliation,
    });
    const retained = {
      unit,
      manifest_sha256: request.manifest.manifest_sha256,
      ...versions,
      reconciliation_plan: reconciliation,
      rejected_items: validation.failures.map((failure) => ({
        rule: failure.rule,
        item: failure.item,
        detail: failure.detail,
      })),
    };
    const planned = `${reconciliation.records.length} record(s), ${reconciliation.held_back.length} held back`;

    const finalUnit = unit.index + 1 === unit.count;
    await this.#options.beforePublication?.();
    const publicationAuthorization =
      this.#restrictedUnit(request) ??
      (await this.#revalidateFrozenAuthorization(input.job, input.decision));
    if (publicationAuthorization !== null)
      return {
        settlement: {
          kind: 'retryable_failure',
          waitReason: publicationAuthorization.waitReason,
          retryAt,
          detail: json({
            ...retained,
            unit_settled: false,
            withdrawn: {
              wait_reason: publicationAuthorization.waitReason,
              detail: publicationAuthorization.detail,
            },
          }),
        },
        detail: `Authorization was withdrawn before publication: ${publicationAuthorization.detail}`,
        pauseReason: null,
      };
    const aggregate = aggregateQuality([
      ...input.priorReceipts.map((receipt) => receipt.quality),
      quality,
    ]);
    const completion: Parameters<typeof publishReconciliationPlanAndSettleAttempt>[0] = {
      handle: this.#handle,
      manifest: request.manifest,
      plan: reconciliation,
      source: input.decision.source,
      processing: {
        generation: this.#generation,
        jobId: input.job.jobId,
        attemptId: input.attempt.attemptId,
        finishedAt: input.finishedAt,
        usage: input.usage,
        manifestSha256: request.manifest.manifest_sha256,
        unit,
        quality,
        outcome: finalUnit
          ? {
              kind: 'completed',
              result: json({
                ...retained,
                unit_settled: true,
                interpretation_quality: aggregate.quality,
                unit_outcomes: aggregate.unit_outcomes,
                coverage: scheduleCoverage(input.schedule, input.priorReceipts, unit.unitId),
              }),
              detail: json({ ...retained, unit_settled: true }),
            }
          : {
              kind: 'unit_completed',
              retryAt: input.finishedAt,
              detail: json({ ...retained, unit_settled: true }),
            },
      },
    };
    let waitedForWriter = false;
    const firstAdmission = new AbortController();
    let publication = await publishReconciliationPlanAndSettleAttempt(completion, {
      signal: firstAdmission.signal,
      onWait: () => {
        waitedForWriter = true;
        this.#options.onPublicationWait?.();
        firstAdmission.abort();
      },
    });
    if (waitedForWriter && publication.kind === 'unavailable' && publication.code === 'CANCELLED') {
      const authorization =
        this.#restrictedUnit(request) ??
        (await this.#revalidateFrozenAuthorization(input.job, input.decision));
      if (authorization !== null)
        return {
          settlement: {
            kind: 'retryable_failure',
            waitReason: authorization.waitReason,
            retryAt,
            detail: json({
              ...retained,
              unit_settled: false,
              withdrawn: {
                wait_reason: authorization.waitReason,
                detail: authorization.detail,
              },
            }),
          },
          detail:
            `Publication waited for the database writer, then authorization was withdrawn: ` +
            authorization.detail,
          pauseReason: null,
        };
      const retryAdmission = new AbortController();
      publication = await publishReconciliationPlanAndSettleAttempt(completion, {
        signal: retryAdmission.signal,
        onWait: () => {
          this.#options.onPublicationWait?.();
          retryAdmission.abort();
        },
      });
    }

    if (publication.kind === 'governing_state_moved') {
      // The whole publication rolled back, so no later selection was overwritten. The plan is
      // retained and a later dispatch reconsiders the job at a newer boundary, under the same
      // limits and against whatever stands then.
      return {
        settlement: {
          kind: 'retryable_failure',
          waitReason: 'governing_state_moved',
          retryAt,
          detail: json({
            ...retained,
            unit_settled: false,
            governing_state_moved: {
              record: publication.record,
              target: publication.target,
              current: publication.current,
            },
          }),
        },
        detail: publication.detail,
        pauseReason: null,
      };
    }
    if (publication.kind === 'unavailable') {
      return {
        settlement: {
          kind: 'retryable_failure',
          waitReason: 'publication_failed',
          retryAt,
          detail: json({
            ...retained,
            unit_settled: false,
            publication_failed: publication.code,
          }),
        },
        detail: publication.detail,
        pauseReason: null,
      };
    }
    if (publication.kind === 'refused') {
      // A refusal the store decides about this plan — a refused credential in the source, an
      // identity that already belongs to something else — is not something a retry answers.
      const refused = json({
        ...retained,
        unit_settled: false,
        publication_refused: { code: publication.code, detail: publication.detail },
        ...retainedProgress,
      });
      return {
        settlement: { kind: 'terminal_failure', result: refused, detail: refused },
        detail: publication.detail,
        pauseReason: null,
      };
    }
    if (publication.kind === 'ownership_lost') {
      this.#lostLease = true;
      return { settlement: null, detail: publication.detail, pauseReason: null };
    }

    const { published } = publication;
    const wrote = `${planned}; ${published.filter((entry) => !entry.replay).length} published, ${published.filter((entry) => entry.replay).length} already retained`;
    return {
      settlement: null,
      detail: finalUnit ? wrote : `unit ${unit.index + 1} of ${unit.count} interpreted: ${wrote}.`,
      pauseReason: null,
    };
  }

  #countLocalCondition(code: string): number {
    this.#consecutiveLocal =
      this.#consecutiveLocal?.code === code
        ? { code, count: this.#consecutiveLocal.count + 1 }
        : { code, count: 1 };
    return this.#consecutiveLocal.count;
  }

  /** A completed job that needed no call, and so took no window and no hold. */
  async #completeWithoutCall(
    job: ProcessingJob,
    decision: Extract<Awaited<ReturnType<typeof decideDispatch>>, { outcome: 'ready' }>,
    schedule: InterpretationProcessingSchedule,
    result: { outcome: string; detail: string }
  ): Promise<KnowledgeWorkerReport | null> {
    const started = await this.#startAttemptWithoutRequest(job, decision, schedule);
    if (started === null) return null;
    const quality = emptyQuality();
    const completion = {
      ...result,
      interpretation_quality: quality,
      unit_outcomes: { accepted: 0, partial: 0, all_rejected: 0, empty: 0 },
      coverage: scheduleCoverage(schedule, []),
    };
    await settleProcessingAttempt(this.#handle, {
      generation: this.#generation,
      jobId: job.jobId,
      attemptId: started.attemptId,
      finishedAt: instant(this.#clock),
      usage: null,
      outcome: {
        kind: 'succeeded',
        publishingOperationId: null,
        result: json(completion),
        detail: json({
          ...result,
          no_call_quality: quality,
          coverage: completion.coverage,
        }),
      },
    });
    this.#jobsSettled += 1;
    this.#log(`Job ${job.jobId} completed without a provider call: ${result.detail}`);
    return null;
  }

  /**
   * An attempt for work decided here, with no reservation: it spends one of the
   * job's attempts, which is what bounds it, and none of the hour's calls,
   * which no call of its own is ever made against.
   */
  async #startAttemptWithoutRequest(
    job: ProcessingJob,
    decision: Extract<Awaited<ReturnType<typeof decideDispatch>>, { outcome: 'ready' }>,
    schedule: InterpretationProcessingSchedule
  ): Promise<{ attemptId: string } | null> {
    const { configuration, grantId, confirmation, permission } = decision;
    const attemptId = uuidv7();
    const start = await startProcessingAttempt(this.#handle, {
      generation: this.#generation,
      jobId: job.jobId,
      attemptId,
      usageId: null,
      startedAt: instant(this.#clock),
      maxAttempts: configuration.maxAttempts,
      configurationIdentity: configuration.configurationIdentity,
      confirmationId: confirmation?.confirmationId ?? null,
      configuration: json({
        provider: configuration.provider,
        model: { id: configuration.model.id, selection: configuration.model.selection },
        effort: configuration.effort.value,
        limits: configuration.limits,
        configuration_source: configuration.source,
        processor_contract: job.processorContract,
        source: job.source,
        schedule_binding: {
          schedule,
          schedule_attempt_id: attemptId,
          unit: null,
        },
        permission,
      }),
      grantId,
    });
    return start.outcome === 'started_without_call' ? { attemptId } : null;
  }

  async #pauseWorkload(reason: string): Promise<void> {
    this.#paused = true;
    this.#pausedDetail = reason;
    await pauseProcessing(this.#handle, {
      generation: this.#generation,
      changedAt: instant(this.#clock),
      changedBy: WORKER_PAUSE_ACTOR,
      changedByBasis: 'other_assertion',
      reason:
        `Background knowledge processing paused itself: ${reason} Run ` +
        `\`orcaops knowledge status\` to see what is waiting, and ` +
        `\`orcaops knowledge resume\` once it is understood.`,
    }).catch((err: unknown) => {
      this.#log(`The workload could not be paused: ${describe(err)}`);
    });
    this.#log(`Paused processing project-wide: ${reason}`);
  }

  #startHeartbeat(): void {
    this.#heartbeat = setInterval(() => {
      if (this.#heartbeatRenewal !== null) return;
      const controller = new AbortController();
      this.#heartbeatAbort = controller;
      const renewal = this.#renewLease(controller).finally(() => {
        if (this.#heartbeatAbort === controller) this.#heartbeatAbort = null;
        if (this.#heartbeatRenewal === renewal) this.#heartbeatRenewal = null;
      });
      this.#heartbeatRenewal = renewal;
    }, this.#options.heartbeatMs);
    this.#heartbeat.unref?.();
  }

  async #renewLease(controller: AbortController): Promise<void> {
    try {
      if (this.#options.renewLease) {
        await this.#options.renewLease(controller.signal);
      } else {
        await renewProcessingLease(
          this.#heartbeatHandle,
          {
            ownerId: this.#options.ownerId,
            generation: this.#generation,
            ...leaseWindow(this.#clock, this.#options.leaseTermMs),
            maxTermMs: this.#options.leaseTermMs,
          },
          { signal: controller.signal }
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      // Ownership is gone. Nothing this worker writes would be accepted, and
      // a superseded owner must not try: the call stops and the loop ends.
      this.#lostLease = true;
      this.#cancelCall?.abort();
      this.#log(`Lost the processing lease: ${describe(err)}`);
    }
  }

  async #stopHeartbeat(): Promise<void> {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.#heartbeatAbort?.abort();
    await this.#heartbeatRenewal;
  }

  #report(outcome: WorkerOutcome, detail?: string): KnowledgeWorkerReport {
    return {
      outcome,
      generation: this.#generation,
      jobsSettled: this.#jobsSettled,
      callsMade: this.#callsMade,
      jobsParked: this.#jobsParked,
      detail: detail ?? DEFAULT_DETAIL[outcome],
    };
  }

  async finish(): Promise<void> {
    await this.#stopHeartbeat();
    this.#heartbeatHandle.close();
    if (!this.#lostLease) {
      await releaseProcessingLease(this.#handle, {
        ownerId: this.#options.ownerId,
        generation: this.#generation,
      }).catch((err: unknown) => {
        this.#log(`The processing lease was not released: ${describe(err)}`);
      });
    }
    this.#handle.close();
  }
}

const DEFAULT_DETAIL: Readonly<Record<WorkerOutcome, string>> = {
  lease_held_by_other: 'Another worker owns this project database.',
  idle: 'Nothing is claimable; the worker exits after its idle interval.',
  stopped: 'The worker was asked to stop; the active call was cancelled and settled.',
  lost_lease: 'Ownership was taken by another worker; this one wrote nothing further.',
  workload_paused: 'Processing was paused project-wide.',
};

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The store's retained-JSON type needs index signatures, which a declared
 * interface never has. The round trip supplies them and, more usefully, refuses
 * anything that does not serialize before it reaches a transaction.
 */
function json(value: unknown): DatabaseJson {
  return JSON.parse(JSON.stringify(value)) as DatabaseJson;
}
