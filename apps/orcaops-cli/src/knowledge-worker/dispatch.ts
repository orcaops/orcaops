import { access } from 'node:fs/promises';

import {
  type EffectiveProcessingConfiguration,
  PROCESSING_PROCESSOR_CONTRACT,
  relatedKnowledgeBounds,
  resolveKnowledgeProcessing,
} from '@orcaops/core';
import {
  measurePreparedInputRequest,
  PROVIDER_CAPABILITIES,
  type ProviderProbeSnapshot,
  resolveNoToolCall,
  selectDefaultProvider,
} from '@orcaops/llm';
import {
  admitsProcessingJob,
  type ScheduledInterpretationSegment,
  type SourcePublicationPath,
} from '@orcaops/storage';
import {
  type ProcessingAttemptPermission,
  type ProcessingJob,
  type ProcessingModelConfirmation,
  type ProjectDatabase,
  type ProjectReadView,
  readLatestProcessingModelConfirmation,
  readProcessingControl,
  readProcessingJobAllowance,
  type RelatedKnowledgeRetrieval,
  retrieveRelatedKnowledge,
  type RetrieveRelatedKnowledgeInput,
} from '@orcaops/storage/history/database';

import { type ProcessingDispatchContext, readDispatchContext } from './dispatch-context.js';
import { type JobSourceRead, readRetainedJobSource, type RetainedJobSource } from './job-source.js';
import {
  evaluateProcessingConsent,
  evaluateProcessingConsentByGrantId,
} from '../lib/knowledge-processing-consent.js';
import { readProcessingGrants } from '../lib/knowledge-processing-grants.js';
import {
  compareProcessingExecutionTerms,
  processingExecutionTerms,
} from '../lib/knowledge-processing-terms.js';
import { resolveRepositoryContext } from '../lib/repository-context.js';

/**
 * Everything that has to hold before a provider is constructed for one job:
 * the source is still a live one this contract admits, the configuration that
 * governs the worktree the capture was made in still enables the workload, and
 * a user-local grant still covers exactly this provider, project and contract
 * under limits no looser than the ones the person was shown.
 *
 * Every refusal is a returned value carrying the wait reason the job is parked
 * with. Nothing here spawns anything, and a caller that reaches
 * `runPreparedInputCall` without a `ready` decision has skipped the consent
 * check this module exists to make.
 */

export interface DispatchRefusal {
  outcome: 'refused';
  /** The job's wait reason, in the worker's own free-text vocabulary. */
  waitReason: string;
  detail: string;
}

export interface DispatchReady {
  outcome: 'ready';
  context: ProcessingDispatchContext;
  /**
   * `source.fields` is empty when the admitted source holds no eligible unrestricted passage.
   * Such a job is completed without a provider call; whether there is anything
   * to interpret is decided here, after authorization, never instead of it.
   */
  source: RetainedJobSource;
  configuration: EffectiveProcessingConfiguration;
  /** The grant that authorizes this attempt, recorded on it. */
  grantId: string;
  confirmation: ProcessingModelConfirmation | null;
  permission: ProcessingAttemptPermission;
  /**
   * What bounded retrieval read for the source at its knowledge boundary,
   * before any provider exists. Null exactly when `source.fields` is empty: a
   * job with nothing to interpret builds no manifest for it to fill.
   */
  retrieval: RelatedKnowledgeRetrieval | null;
}

export interface DispatchExhausted {
  outcome: 'attempts_exhausted';
  configuration: EffectiveProcessingConfiguration;
}

export type DispatchDecision = DispatchReady | DispatchRefusal | DispatchExhausted;

export type RetrieveRelatedKnowledge = (
  view: ProjectReadView,
  input: RetrieveRelatedKnowledgeInput
) => RelatedKnowledgeRetrieval;

export interface DispatchInput {
  handle: ProjectDatabase;
  job: ProcessingJob;
  projectId: string;
  /** Probed once per worker run; probing spawns a version check per provider. */
  providerAvailability: ProviderProbeSnapshot;
  /** Test seam. Production takes the store's reader. */
  retrieve?: RetrieveRelatedKnowledge;
}

const refused = (waitReason: string, detail: string): DispatchRefusal => ({
  outcome: 'refused',
  waitReason,
  detail,
});

interface RetainedAdmission {
  path: SourcePublicationPath;
  derivedByProcessing: boolean;
}

function retainedAdmission(admission: unknown): RetainedAdmission | null {
  if (admission === null || typeof admission !== 'object' || Array.isArray(admission)) return null;
  const record = admission as Record<string, unknown>;
  if (typeof record.path !== 'string' || typeof record.derived_by_processing !== 'boolean') {
    return null;
  }
  return {
    path: record.path as SourcePublicationPath,
    derivedByProcessing: record.derived_by_processing,
  };
}

/**
 * The access restriction the retained source of this capture field carries, or null when this
 * history retains no source for it yet.
 *
 * Read by the OCCURRENCE and not by the id this worker would derive for it: one capture-field
 * occurrence is one source, and a person who published it before the detector read it gave it an
 * id of their own. That is the same rule the publication applies when it cites their source
 * instead of authoring one, and reading by the derived id would miss exactly the sources people
 * have already cared enough about to restrict.
 */
export function retainedSourceRestriction(
  handle: ProjectDatabase,
  occurrence: { event_id: string; field_path: string; position: number }
): string | null {
  const row = handle.read((view) =>
    view.get<{ access_restriction: string | null }>(
      `SELECT access_restriction FROM knowledge_sources
        WHERE source_kind='capture_field' AND event_id=? AND field_path=? AND position=?`,
      occurrence.event_id,
      occurrence.field_path,
      occurrence.position
    )
  ).value;
  return row?.access_restriction ?? null;
}

export function restrictedScheduledFields(
  handle: ProjectDatabase,
  segments: readonly ScheduledInterpretationSegment[]
): string[] {
  const restricted = new Set<string>();
  for (const segment of segments) {
    if (
      retainedSourceRestriction(handle, {
        event_id: segment.occurrence.event_id,
        field_path: segment.occurrence.field_path,
        position: segment.occurrence.position,
      }) !== null
    )
      restricted.add(segment.occurrence.field_path);
  }
  return [...restricted];
}

/**
 * The admitted sequence of one job: the write sequence of the operation that
 * published its source. Admission moves no counter of its own, so it is read
 * back through the admitting operation, exactly as the queue readers do.
 *
 * Exported so the explicit model resume judges consent against the same number
 * dispatch will: a verb that allowed a job the worker then refuses would be a
 * consent decision made twice, differently.
 */
export function admittedSequenceOf(handle: ProjectDatabase, job: ProcessingJob): number {
  const row = handle.read((view) =>
    view.get<{ sequence: number | null }>(
      'SELECT o.committed_write_sequence AS sequence FROM operations o WHERE o.operation_id=?',
      job.admittingOperationId
    )
  ).value;
  return row?.sequence ?? 0;
}

function sourceRefusal(read: Extract<JobSourceRead, { ok: false }>): DispatchRefusal {
  return refused(
    read.reason === 'event_not_eligible' ? 'source_not_eligible' : 'source_unavailable',
    read.detail
  );
}

async function resolveOriginConfiguration(
  worktreeRoot: string,
  availability: ProviderProbeSnapshot
): Promise<
  { ok: true; configuration: EffectiveProcessingConfiguration } | { ok: false; detail: string }
> {
  try {
    await access(worktreeRoot);
  } catch {
    return {
      ok: false,
      detail:
        `The worktree this capture was made in (${worktreeRoot}) is gone, so the configuration ` +
        `that governs it cannot be read. No other worktree's settings are used in its place.`,
    };
  }
  let repository;
  try {
    // Pinned as the root rather than discovered, so a `--root` the worker
    // itself was started with cannot redirect a job to another checkout.
    repository = await resolveRepositoryContext({
      cwd: worktreeRoot,
      root: worktreeRoot,
      requireInit: false,
    });
  } catch (err) {
    return {
      ok: false,
      detail:
        `The worktree this capture was made in (${worktreeRoot}) no longer resolves: ` +
        `${(err as Error).message}`,
    };
  }
  const resolution = resolveKnowledgeProcessing({
    config: repository.config,
    source: { kind: repository.source.kind, path: repository.source.configPath },
    providerAvailability: availability,
    llm: {
      capabilities: PROVIDER_CAPABILITIES,
      selectDefaultProvider,
      resolveNoToolCall,
      measurePreparedInputRequest,
    },
  });
  if (resolution.status !== 'ready') {
    return {
      ok: false,
      detail: resolution.reasons.map((reason) => reason.message).join(' '),
    };
  }
  return { ok: true, configuration: resolution.configuration };
}

/**
 * The two things that can be withdrawn while a call is in flight: the
 * configuration that enables the workload and the grant that authorizes it.
 * Re-read on their own, without reconstructing the artifact, so watching a live
 * call costs a configuration read and a grant-file read and nothing else.
 */
export async function revalidateAuthorization(input: {
  handle: ProjectDatabase;
  job: ProcessingJob;
  permission: ProcessingAttemptPermission;
  providerAvailability: ProviderProbeSnapshot;
}): Promise<{ ok: true } | DispatchRefusal> {
  if (readProcessingControl(input.handle)?.paused === true) {
    return refused('project_paused', 'Processing was paused project-wide.');
  }
  const configuration = await resolveOriginConfiguration(
    input.permission.execution_terms.origin.worktree_root,
    input.providerAvailability
  );
  if (!configuration.ok) return refused('configuration_paused', configuration.detail);
  const currentTerms = processingExecutionTerms({
    projectId: input.permission.execution_terms.project_id,
    job: input.job,
    worktreeRoot: input.permission.execution_terms.origin.worktree_root,
    configuration: configuration.configuration,
  });
  const comparison = compareProcessingExecutionTerms({
    frozen: input.permission.execution_terms,
    current: currentTerms,
    phase: 'active',
  });
  if (!comparison.ok)
    return refused(
      'execution_terms_changed',
      `The active call can no longer honor: ${comparison.changed.join(', ')}.`
    );
  const { grants, problems } = readProcessingGrants({
    repoRoot: input.permission.execution_terms.origin.worktree_root,
  });
  const frozen = input.permission.execution_terms;
  const decision = evaluateProcessingConsentByGrantId({
    grants,
    problems,
    grant_id: input.permission.attempt_grant_id,
    project_id: frozen.project_id,
    provider: frozen.provider.id,
    processor_contract: frozen.processor_contract,
    effective_tool_access: frozen.tool_access,
    effective_limits: frozen.limits,
    job: { admitted_sequence: admittedSequenceOf(input.handle, input.job) },
  });
  if (!decision.ok) return refused(decision.reason, `${decision.code}: ${decision.message}`);
  return { ok: true };
}

export async function decideDispatch(input: DispatchInput): Promise<DispatchDecision> {
  const { handle, job } = input;

  if (job.processorContract !== PROCESSING_PROCESSOR_CONTRACT) {
    // Not `other_processor_contract`: that is a consent denial, which a new
    // grant resolves. This one is a fact about the job, which nothing resolves.
    return refused(
      'unsupported_processor_contract',
      `The job was admitted for processor contract ${JSON.stringify(job.processorContract)}, ` +
        `and this build runs ${JSON.stringify(PROCESSING_PROCESSOR_CONTRACT)}. History processed under ` +
        `another contract is never reinterpreted under this one.`
    );
  }
  if (job.source.kind !== 'capture_event') {
    return refused(
      'source_kind_unsupported',
      'This build interprets captured events; a knowledge source is a later slice.'
    );
  }
  // Claiming already excludes both, so reaching either means something changed
  // under this owner. Neither is worth a provider.
  const confirmation = job.withoutModel
    ? handle.read((view) => readLatestProcessingModelConfirmation(view, job.jobId)).value
    : null;
  if (job.withoutModel && confirmation === null)
    return refused(
      'awaiting_model_resume',
      'The invocation that captured this source chose no model, and no explicit confirmation has lifted that choice.'
    );
  if (readProcessingControl(handle)?.paused === true) {
    return refused('project_paused', 'Processing is paused project-wide.');
  }

  const context = readDispatchContext(job.admission);
  if (!context.ok) return refused('dispatch_context_missing', context.detail);

  // Decide exhaustion before any refusal: a parked exhausted job is reclaimed and refused forever.
  const configuration = await resolveOriginConfiguration(
    context.context.origin.worktree_root,
    input.providerAvailability
  );
  if (configuration.ok) {
    const allowance = readProcessingJobAllowance(
      handle,
      job.jobId,
      configuration.configuration.maxAttempts
    );
    if (allowance.attemptsMade >= allowance.attemptsAllowed)
      return { outcome: 'attempts_exhausted', configuration: configuration.configuration };
  }

  const sourceRead = readRetainedJobSource(handle, {
    artifactId: context.context.artifact_id,
    eventId: job.source.event_id,
  });
  if (!sourceRead.ok) return sourceRefusal(sourceRead);
  const retainedSource = sourceRead.source;

  const admission = retainedAdmission(job.admission);
  if (admission === null) {
    return refused(
      'admission_unreadable',
      'The job does not retain how its source was published, so the admission rule cannot be ' +
        'applied to it again.'
    );
  }
  if (
    !admitsProcessingJob({
      path: admission.path,
      origin_kind: retainedSource.originKind,
      settled_event_types: [retainedSource.eventType],
      derived_by_processing: admission.derivedByProcessing,
    })
  ) {
    return refused(
      'source_not_eligible',
      `A ${retainedSource.eventType} event published by ${admission.path} on a ${retainedSource.originKind} ` +
        `artifact is not a live source this contract interprets. No provider is constructed for it.`
    );
  }

  if (!configuration.ok) return refused('configuration_paused', configuration.detail);

  const { grants, problems } = readProcessingGrants({
    repoRoot: context.context.origin.worktree_root,
  });
  const decision = evaluateProcessingConsent({
    grants,
    problems,
    project_id: input.projectId,
    provider: configuration.configuration.provider.id,
    processor_contract: PROCESSING_PROCESSOR_CONTRACT,
    effective_tool_access: configuration.configuration.toolAccess,
    effective_limits: configuration.configuration.limits,
    job: { admitted_sequence: admittedSequenceOf(handle, job) },
  });
  if (!decision.ok) return refused(decision.reason, `${decision.code}: ${decision.message}`);

  const executionTerms = processingExecutionTerms({
    projectId: input.projectId,
    job,
    worktreeRoot: context.context.origin.worktree_root,
    configuration: configuration.configuration,
  });
  if (confirmation !== null) {
    const comparison = compareProcessingExecutionTerms({
      frozen: confirmation.terms,
      current: executionTerms,
      phase: 'dispatch',
    });
    if (!comparison.ok)
      return refused(
        'model_reconfirmation_required',
        `Current execution terms exceed or differ from the confirmed terms: ${comparison.changed.join(', ')}.`
      );
  }

  const unrestricted = retainedSource.fields.filter(
    (field) =>
      retainedSourceRestriction(handle, {
        event_id: retainedSource.eventId,
        field_path: field.fieldPath,
        position: field.position,
      }) === null
  );
  const restrictedPaths = new Set(
    retainedSource.fields
      .filter((field) => !unrestricted.includes(field))
      .map((field) => field.fieldPath)
  );
  const source: RetainedJobSource = {
    ...retainedSource,
    fields: unrestricted,
    omissions: [
      ...retainedSource.omissions,
      ...[...restrictedPaths].map((fieldPath) => ({
        fieldPath,
        reason: 'The authored field is access restricted and was not supplied for interpretation.',
      })),
    ],
  };

  const retrieval = retrieveForSource(input, source, configuration.configuration);
  if ('waitReason' in retrieval) return retrieval;

  return {
    outcome: 'ready',
    context: context.context,
    source,
    configuration: configuration.configuration,
    grantId: decision.grant_id,
    confirmation,
    permission: {
      v: 1,
      confirmation_id: confirmation?.confirmationId ?? null,
      confirmed_terms: confirmation?.terms ?? null,
      execution_terms: executionTerms,
      attempt_grant_id: decision.grant_id,
    },
    retrieval: retrieval.retrieval,
  };
}

/**
 * Related knowledge is read here, at the boundary the source was read at and
 * in the scope the manifest will state for it, so the manifest is built from
 * one moment of the store. A retrieval that fails is a refusal: a manifest
 * with a silently empty related set would tell a model nothing related exists.
 */
function retrieveForSource(
  input: DispatchInput,
  source: RetainedJobSource,
  configuration: EffectiveProcessingConfiguration
): { retrieval: RelatedKnowledgeRetrieval | null } | DispatchRefusal {
  const primaryFields = source.fields.filter((field) => field.purpose === 'primary');
  if (primaryFields.length === 0) return { retrieval: null };
  const retrieve = input.retrieve ?? retrieveRelatedKnowledge;
  const request: RetrieveRelatedKnowledgeInput = {
    source: {
      artifactId: source.artifactId,
      eventId: source.eventId,
      planEventId: source.planEventId,
      text: primaryFields.map((field) => field.preparedText).join('\n'),
    },
    projectId: input.projectId,
    scope: { kind: 'artifact', artifact_id: source.artifactId },
    boundary: source.knowledgeBoundary,
    bounds: relatedKnowledgeBounds(configuration.limits),
  };
  try {
    return { retrieval: input.handle.read((view) => retrieve(view, request)).value };
  } catch (err) {
    return refused(
      'retrieval_failed',
      `Related knowledge could not be read for the source at write sequence ` +
        `${source.knowledgeBoundary}: ${(err as Error).message} No provider is constructed ` +
        `for a manifest whose related knowledge is unknown.`
    );
  }
}
