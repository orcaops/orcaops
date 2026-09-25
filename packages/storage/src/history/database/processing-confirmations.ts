import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { ProcessingDispatchContextSchema } from './processing-dispatch-context.js';
import {
  decodeProcessingJob,
  PROCESSING_JOB_COLUMNS,
  type ProcessingAttributionBasis,
  type ProcessingJobRow,
} from './processing-jobs.js';
import {
  processingInstant,
  processingRecordId,
  processingText,
  runProcessingMaintenance,
} from './processing-maintenance.js';
import type { ProjectOperationOptions } from './transactions.js';
import { serializeDatabaseValue } from './values.js';

const ActorBasisSchema = z.enum([
  'authenticated',
  'source_attributed',
  'agent_reported_user_instruction',
  'other_assertion',
  'unknown',
]);

const PerCallSpendSchema = z.union([
  z.literal('none'),
  z.object({ usd: z.number().nonnegative(), holds: z.enum(['ceiling', 'best_effort']) }).strict(),
]);

export const ProcessingConfirmationTermsSchema = z
  .object({
    v: z.literal(1),
    project_id: z.string().min(1),
    job_id: z.string().min(1),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('capture_event'), event_id: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('knowledge_source'), source_id: z.string().min(1) }).strict(),
    ]),
    origin: ProcessingDispatchContextSchema.shape.origin,
    processor_contract: z.string().min(1),
    provider: z
      .object({ id: z.enum(['claude', 'codex']), selection: z.enum(['explicit', 'inherited']) })
      .strict(),
    model: z.discriminatedUnion('selection', [
      z.object({ selection: z.enum(['explicit', 'inherited']), id: z.string().min(1) }).strict(),
      z.object({ selection: z.literal('provider_default'), id: z.null() }).strict(),
    ]),
    effort: z.discriminatedUnion('selection', [
      z.object({ selection: z.enum(['explicit', 'inherited']), value: z.string().min(1) }).strict(),
      z.object({ selection: z.literal('provider_default'), value: z.null() }).strict(),
    ]),
    tool_access: z.enum(['none', 'codex_restricted']),
    limits: z
      .object({
        max_cost_usd_per_call: PerCallSpendSchema,
        max_cost_usd_per_day: z.union([z.number().nonnegative(), z.literal('none')]),
        max_calls_per_hour: z.number().int().positive(),
        max_input_bytes: z.number().int().positive(),
        max_output_bytes: z.number().int().positive(),
      })
      .strict(),
    output_token_cap: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('enforced'), tokens: z.number().int().positive() }).strict(),
      z.object({ kind: z.literal('none') }).strict(),
    ]),
    timeout_ms: z.number().int().positive(),
    max_attempts: z.number().int().positive(),
  })
  .strict();

export type ProcessingConfirmationTerms = z.infer<typeof ProcessingConfirmationTermsSchema>;

export type ProcessingTermsComparison = { ok: true } | { ok: false; changed: readonly string[] };

type TermsCeiling = number | 'none';

function ceilingAtMost(actual: TermsCeiling, allowed: TermsCeiling): boolean {
  return allowed === 'none' || (actual !== 'none' && actual <= allowed);
}

function perCallAtMost(
  actual: ProcessingConfirmationTerms['limits']['max_cost_usd_per_call'],
  allowed: ProcessingConfirmationTerms['limits']['max_cost_usd_per_call']
): boolean {
  if (allowed === 'none') return true;
  if (actual === 'none' || actual.usd > allowed.usd) return false;
  return allowed.holds === 'best_effort' || actual.holds === 'ceiling';
}

/**
 * At dispatch, current terms must fit inside the confirmed envelope. While a
 * call runs, current terms must still permit every bound frozen on that call;
 * a newly tighter bound cannot be imposed on work that is already executing.
 */
export function compareProcessingExecutionTerms(input: {
  frozen: ProcessingConfirmationTerms;
  current: ProcessingConfirmationTerms;
  phase: 'dispatch' | 'active';
}): ProcessingTermsComparison {
  const { frozen, current } = input;
  const changed: string[] = [];
  const exact: (keyof ProcessingConfirmationTerms)[] = [
    'v',
    'project_id',
    'job_id',
    'source',
    'origin',
    'processor_contract',
    'provider',
    'model',
    'effort',
    'tool_access',
  ];
  for (const name of exact) if (!isDeepStrictEqual(frozen[name], current[name])) changed.push(name);

  const narrower = input.phase === 'dispatch' ? current : frozen;
  const wider = input.phase === 'dispatch' ? frozen : current;
  const check = (name: string, fits: boolean) => {
    if (!fits) changed.push(name);
  };
  check(
    'limits.max_cost_usd_per_call',
    perCallAtMost(narrower.limits.max_cost_usd_per_call, wider.limits.max_cost_usd_per_call)
  );
  if (input.phase === 'dispatch') {
    check(
      'limits.max_cost_usd_per_day',
      ceilingAtMost(narrower.limits.max_cost_usd_per_day, wider.limits.max_cost_usd_per_day)
    );
    check(
      'limits.max_calls_per_hour',
      narrower.limits.max_calls_per_hour <= wider.limits.max_calls_per_hour
    );
  }
  for (const name of ['max_input_bytes', 'max_output_bytes'] as const)
    check(`limits.${name}`, narrower.limits[name] <= wider.limits[name]);
  check(
    'output_token_cap',
    ceilingAtMost(
      narrower.output_token_cap.kind === 'none' ? 'none' : narrower.output_token_cap.tokens,
      wider.output_token_cap.kind === 'none' ? 'none' : wider.output_token_cap.tokens
    )
  );
  check('timeout_ms', narrower.timeout_ms <= wider.timeout_ms);
  if (input.phase === 'dispatch')
    check('max_attempts', narrower.max_attempts <= wider.max_attempts);
  return changed.length === 0 ? { ok: true } : { ok: false, changed };
}

export const ProcessingAttemptPermissionSchema = z
  .object({
    v: z.literal(1),
    confirmation_id: z.string().min(1).nullable(),
    confirmed_terms: ProcessingConfirmationTermsSchema.nullable(),
    execution_terms: ProcessingConfirmationTermsSchema,
    attempt_grant_id: z.string().min(1),
  })
  .strict()
  .refine(
    (permission) => (permission.confirmation_id === null) === (permission.confirmed_terms === null),
    { message: 'confirmation identity and terms must either both be present or both be absent' }
  );
export type ProcessingAttemptPermission = z.infer<typeof ProcessingAttemptPermissionSchema>;

export interface ProcessingModelConfirmation {
  confirmationId: string;
  jobId: string;
  confirmationSequence: number;
  confirmedAt: string;
  confirmedBy: string | null;
  confirmedByBasis: ProcessingAttributionBasis;
  grantId: string;
  terms: ProcessingConfirmationTerms;
}

interface ConfirmationRow {
  confirmationId: string;
  jobId: string;
  confirmationSequence: number;
  confirmedAt: string;
  confirmedBy: string | null;
  confirmedByBasis: string;
  grantId: string;
  termsJson: string;
}

const CONFIRMATION_COLUMNS = `confirmation_id AS confirmationId, job_id AS jobId,
  confirmation_sequence AS confirmationSequence, confirmed_at AS confirmedAt,
  confirmed_by AS confirmedBy, confirmed_by_basis AS confirmedByBasis,
  grant_id AS grantId, terms_json AS termsJson`;

function decodeConfirmation(row: ConfirmationRow): ProcessingModelConfirmation {
  const basis = ActorBasisSchema.safeParse(row.confirmedByBasis);
  let terms;
  try {
    terms = ProcessingConfirmationTermsSchema.safeParse(JSON.parse(row.termsJson));
  } catch {
    terms = { success: false } as const;
  }
  if (!basis.success || !terms.success)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'A retained processing model confirmation is malformed; preserve history for explicit repair'
    );
  return {
    confirmationId: row.confirmationId,
    jobId: row.jobId,
    confirmationSequence: row.confirmationSequence,
    confirmedAt: row.confirmedAt,
    confirmedBy: row.confirmedBy,
    confirmedByBasis: basis.data,
    grantId: row.grantId,
    terms: terms.data,
  };
}

export function readProcessingModelConfirmation(
  view: ProjectReadView,
  confirmationId: string
): ProcessingModelConfirmation | null {
  const id = processingRecordId(confirmationId, 'processing model confirmation');
  const row = view.get<ConfirmationRow>(
    `SELECT ${CONFIRMATION_COLUMNS} FROM processing_model_confirmations WHERE confirmation_id=?`,
    id
  );
  return row ? decodeConfirmation(row) : null;
}

export function readLatestProcessingModelConfirmation(
  view: ProjectReadView,
  jobId: string
): ProcessingModelConfirmation | null {
  const id = processingRecordId(jobId, 'processing job');
  const row = view.get<ConfirmationRow>(
    `SELECT ${CONFIRMATION_COLUMNS} FROM processing_model_confirmations
      WHERE job_id=? ORDER BY confirmation_sequence DESC LIMIT 1`,
    id
  );
  return row ? decodeConfirmation(row) : null;
}

export function readProcessingModelConfirmationHistory(
  view: ProjectReadView,
  jobId: string
): ProcessingModelConfirmation[] {
  const id = processingRecordId(jobId, 'processing job');
  return view
    .all<ConfirmationRow>(
      `SELECT ${CONFIRMATION_COLUMNS} FROM processing_model_confirmations
        WHERE job_id=? ORDER BY confirmation_sequence`,
      id
    )
    .map(decodeConfirmation);
}

export interface RecordProcessingModelConfirmation {
  confirmationId: string;
  jobId: string;
  expectedPreviousSequence: number | null;
  confirmedAt: string;
  confirmedBy: string | null;
  confirmedByBasis: ProcessingAttributionBasis;
  grantId: string;
  terms: ProcessingConfirmationTerms;
}

export async function recordProcessingModelConfirmation(
  handle: ProjectDatabase,
  input: RecordProcessingModelConfirmation,
  options: ProjectOperationOptions = {}
): Promise<ProcessingModelConfirmation> {
  const confirmationId = processingRecordId(input.confirmationId, 'processing model confirmation');
  const jobId = processingRecordId(input.jobId, 'processing job');
  const confirmedAt = processingInstant(input.confirmedAt, 'the model confirmation time');
  const basisResult = ActorBasisSchema.safeParse(input.confirmedByBasis);
  if (!basisResult.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Say how the person who confirmed model processing is known'
    );
  const basis = basisResult.data;
  const confirmedBy =
    input.confirmedBy === null
      ? null
      : processingText(input.confirmedBy, 'who confirmed model processing');
  if ((confirmedBy === null) !== (basis === 'unknown'))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Only an unknown actor has no name, and a named actor says how the name is known'
    );
  const grantId = processingText(input.grantId, 'the confirmation grant');
  const termsResult = ProcessingConfirmationTermsSchema.safeParse(input.terms);
  if (!termsResult.success)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'The model confirmation terms are not a valid versioned execution envelope'
    );
  const terms = termsResult.data;
  if (terms.job_id !== jobId)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Confirmation terms name another job');
  if (
    input.expectedPreviousSequence !== null &&
    (!Number.isSafeInteger(input.expectedPreviousSequence) || input.expectedPreviousSequence < 1)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'The expected previous confirmation sequence must be null or a positive whole number'
    );
  const termsJson = serializeDatabaseValue(terms);
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.model-confirmation.record',
    (transaction) => {
      const row = transaction.get<ProcessingJobRow>(
        `SELECT ${PROCESSING_JOB_COLUMNS} FROM processing_jobs WHERE job_id=?`,
        jobId
      );
      if (!row) throw new ProjectDatabaseError('HISTORY_MISSING', 'The processing job is missing');
      const job = decodeProcessingJob(row);
      if (!job.withoutModel)
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'Only a job originally admitted without a model needs a model confirmation'
        );
      if (!['pending', 'retryable_failure'].includes(job.state))
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'Only an unfinished idle processing job can receive a model confirmation'
        );
      if (
        transaction.get(
          'SELECT attempt_id FROM processing_attempts WHERE job_id=? AND outcome IS NULL',
          jobId
        )
      )
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'A processing job with an open attempt cannot receive a model confirmation'
        );
      if (readProcessingModelConfirmation(transaction, confirmationId) !== null)
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'The processing model confirmation identity already belongs to retained history'
        );
      const latest = readLatestProcessingModelConfirmation(transaction, jobId);
      const previous = latest?.confirmationSequence ?? null;
      if (previous !== input.expectedPreviousSequence)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing job confirmation changed; show and confirm its current terms again'
        );
      const sourceMatches =
        terms.source.kind === job.source.kind &&
        (terms.source.kind === 'capture_event'
          ? terms.source.event_id ===
            (job.source.kind === 'capture_event' ? job.source.event_id : null)
          : terms.source.source_id ===
            (job.source.kind === 'knowledge_source' ? job.source.source_id : null));
      const admission =
        job.admission !== null && typeof job.admission === 'object' && !Array.isArray(job.admission)
          ? (job.admission as Record<string, unknown>)
          : null;
      const context = ProcessingDispatchContextSchema.safeParse(admission?.context);
      if (
        terms.project_id !== handle.authority.projectId ||
        !context.success ||
        terms.origin.worktree_root !== context.data.origin.worktree_root ||
        !sourceMatches ||
        terms.processor_contract !== job.processorContract
      )
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'Confirmation terms do not name this project, originating worktree, source and processor contract'
        );
      const confirmationSequence = (previous ?? 0) + 1;
      transaction.run(
        `INSERT INTO processing_model_confirmations
          (confirmation_id,job_id,confirmation_sequence,confirmed_at,confirmed_by,
            confirmed_by_basis,grant_id,terms_json) VALUES (?,?,?,?,?,?,?,?)`,
        confirmationId,
        jobId,
        confirmationSequence,
        confirmedAt,
        confirmedBy,
        basis,
        grantId,
        termsJson
      );
      if (confirmationSequence === 1) {
        const changes = transaction.run(
          `UPDATE processing_jobs SET model_resumed_at=?, model_resumed_by=?,
            model_resumed_by_basis=?, model_resume_grant_id=?, updated_at=?
            WHERE job_id=? AND model_resumed_at IS NULL`,
          confirmedAt,
          confirmedBy,
          basis,
          grantId,
          confirmedAt,
          jobId
        ).changes;
        if (changes !== 1)
          throw new ProjectDatabaseError(
            'HISTORY_INTEGRITY_REQUIRED',
            'The first model confirmation could not retain its audit marker'
          );
      }
      transaction.run(
        `UPDATE processing_jobs SET wait_reason=NULL, retry_at=NULL, updated_at=?
          WHERE job_id=? AND wait_reason IN ('awaiting_model_resume','model_reconfirmation_required')`,
        confirmedAt,
        jobId
      );
      return {
        confirmationId,
        jobId,
        confirmationSequence,
        confirmedAt,
        confirmedBy,
        confirmedByBasis: basis,
        grantId,
        terms,
      };
    },
    options
  );
}
