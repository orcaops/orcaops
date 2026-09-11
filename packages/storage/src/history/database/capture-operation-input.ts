import { z } from 'zod';

import { canonicalJson } from '../../events/canonical-json.js';
import { UuidV7Schema } from '../../ids/uuidv7.js';
import {
  type ArtifactAttemptRow,
  ArtifactAttemptRowSchema,
  artifactLifecycleKey,
  type ArtifactLifecycleRow,
  ArtifactLifecycleRowSchema,
} from '../capture-operation-records.js';
import { CounterSchema, digest, DigestSchema } from '../event-integrity.js';
import {
  type ArtifactSourceTimeMember,
  ArtifactSourceTimeMemberSchema,
  prepareSourceCommitTime,
} from '../source-time.js';
import { refuseJsonBytes } from './authored-bytes.js';
import { ProjectDatabaseError } from './errors.js';

const text = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'));
const positive = CounterSchema.refine((value) => value > 0);
const RevisionSchema = z.strictObject({
  generation: positive,
  orderedHash: DigestSchema,
  eventCount: positive,
  byteLength: positive,
  tailEventId: UuidV7Schema,
});
const SelectionSchema = z.strictObject({ revisionId: UuidV7Schema, version: positive });
const SourceSchema = z.strictObject({
  identity: text,
  locator: text,
  revisionId: text.nullable(),
  eventId: text.nullable(),
  operationId: text.nullable(),
  sha256: DigestSchema.nullable(),
});
const common = {
  operationId: UuidV7Schema,
  revisionId: UuidV7Schema,
  artifactId: UuidV7Schema,
  artifactRevision: RevisionSchema,
  expectedSelection: SelectionSchema.nullable(),
  source: SourceSchema,
};
const RecordInputSchema = z.strictObject({
  ...common,
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
});
const AttemptInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...RecordInputSchema.shape, action: z.literal('set') }),
  z.strictObject({
    ...common,
    action: z.literal('clear'),
    expectedSelection: SelectionSchema,
    eventType: text,
    idempotencyKey: text,
  }),
]);
const AuthoredOptionsSchema = z.strictObject({ secretAllow: z.array(z.string()) });
const HistoricalOptionsSchema = z.strictObject({ sourceProfile: z.literal('0.2.0-rc.2') });

export type CaptureOperationSelection = z.infer<typeof SelectionSchema>;
export type CaptureOperationSource = z.infer<typeof SourceSchema>;
export type LifecycleCompletionInput = z.infer<typeof RecordInputSchema>;
export type ArtifactAttemptInput = z.infer<typeof AttemptInputSchema>;
export type CaptureAuthoredOptions = z.infer<typeof AuthoredOptionsSchema>;
export type CaptureHistoricalOptions = z.infer<typeof HistoricalOptionsSchema>;
interface PreparationContext {
  readonly sourceKind: 'authored' | 'historical';
  readonly sourceProfile: '0.2.0-rc.2' | null;
  readonly secretAllow: readonly string[];
}
interface RetainedCaptureBytes {
  readonly operationId: string;
  readonly artifactId: string;
  readonly artifactRevision: Readonly<z.infer<typeof RevisionSchema>>;
  readonly source: Readonly<CaptureOperationSource>;
  readonly sourceKind: 'authored' | 'historical';
  readonly sourceProfile: '0.2.0-rc.2' | null;
  readonly bytesBase64: string | null;
  readonly recordHash: string | null;
}
interface RetainedCaptureRecord extends RetainedCaptureBytes {
  readonly revisionId: string;
  readonly expectedSelection: Readonly<CaptureOperationSelection> | null;
}
export interface LifecycleCompletionPreparation extends RetainedCaptureRecord {
  readonly kind: 'lifecycle';
  readonly key: string;
  readonly row: Readonly<ArtifactLifecycleRow>;
}
export interface ArtifactAttemptPreparation extends RetainedCaptureRecord {
  readonly kind: 'attempt';
  readonly action: 'set' | 'clear';
  readonly eventType: string;
  readonly idempotencyKey: string;
  readonly row: Readonly<ArtifactAttemptRow> | null;
}
export interface PreparedLifecycleCompletion {
  readonly kind: 'prepared-lifecycle-completion';
}
export interface PreparedArtifactAttempt {
  readonly kind: 'prepared-artifact-attempt';
}
const lifecyclePreparations = new WeakMap<
  PreparedLifecycleCompletion,
  LifecycleCompletionPreparation
>();
const attemptPreparations = new WeakMap<PreparedArtifactAttempt, ArtifactAttemptPreparation>();
function invalid(message: string, cause?: unknown): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message, { cause });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    invalid('Provide exact typed capture record identities and values', result.error);
  return result.data;
}
function context(mode: 'authored' | 'historical', options: unknown): PreparationContext {
  if (mode === 'authored') {
    const value = parse(AuthoredOptionsSchema, options);
    return { sourceKind: mode, sourceProfile: null, secretAllow: value.secretAllow };
  }
  const value = parse(HistoricalOptionsSchema, options);
  return { sourceKind: mode, sourceProfile: value.sourceProfile, secretAllow: [] };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function retained(
  input: Omit<z.infer<z.ZodObject<typeof common>>, 'revisionId' | 'expectedSelection'>,
  bytes: Uint8Array | null,
  ctx: PreparationContext
): RetainedCaptureBytes {
  const copy = bytes === null ? null : Buffer.from(bytes);
  const recordHash = copy === null ? null : digest(copy);
  if (input.source.sha256 !== null && input.source.sha256 !== recordHash)
    invalid('Supplied source checksum must match the exact supplied record representation');
  const metadata = {
    operationId: input.operationId,
    artifactId: input.artifactId,
    artifactRevision: input.artifactRevision,
    source: input.source,
    sourceKind: ctx.sourceKind,
    sourceProfile: ctx.sourceProfile,
  };
  if (ctx.sourceKind === 'authored') {
    refuseJsonBytes(Buffer.from(canonicalJson(metadata)), ctx.secretAllow);
    if (copy !== null) refuseJsonBytes(copy, ctx.secretAllow);
  }
  return { ...metadata, bytesBase64: copy?.toString('base64') ?? null, recordHash };
}
function selectedRecord(
  input: z.infer<z.ZodObject<typeof common>>,
  bytes: Uint8Array | null,
  ctx: PreparationContext
): RetainedCaptureRecord {
  return {
    ...retained(input, bytes, ctx),
    revisionId: input.revisionId,
    expectedSelection: input.expectedSelection,
  };
}
function decode<T>(record: RetainedCaptureBytes, schema: z.ZodType<T>, ctx: PreparationContext): T {
  if (record.bytesBase64 === null) invalid('The set record requires exact original bytes');
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(record.bytesBase64, 'base64'))
    );
  } catch (cause) {
    invalid('Provide complete UTF-8 JSON capture record bytes', cause);
  }
  const value = parse(schema, raw);
  if (ctx.sourceKind === 'authored' && canonicalJson(value) !== canonicalJson(raw))
    invalid(
      'Authored capture fields must match their typed record without dropping or normalizing values'
    );
  return value;
}
function lifecycle(
  input: LifecycleCompletionInput,
  ctx: PreparationContext
): PreparedLifecycleCompletion {
  const value = parse(RecordInputSchema, input);
  const record = selectedRecord(value, value.bytes, ctx);
  const row = decode(record, ArtifactLifecycleRowSchema, ctx);
  if (
    ctx.sourceKind === 'authored' &&
    row.cp_n === 0 &&
    ['checkpoint-open', 'checkpoint-close', 'post-plan-revision'].includes(row.fires_at)
  )
    invalid('Sequenced lifecycle completion requires its original positive sequence');
  const prepared = Object.freeze({ kind: 'prepared-lifecycle-completion' as const });
  lifecyclePreparations.set(
    prepared,
    freeze({ ...record, kind: 'lifecycle', key: artifactLifecycleKey(row), row })
  );
  return prepared;
}
function attempt(input: ArtifactAttemptInput, ctx: PreparationContext): PreparedArtifactAttempt {
  const value = parse(AttemptInputSchema, input);
  const record = selectedRecord(value, value.action === 'set' ? value.bytes : null, ctx);
  const row = value.action === 'set' ? decode(record, ArtifactAttemptRowSchema, ctx) : null;
  if (row !== null && row.artifact_id !== value.artifactId)
    invalid('Attempt outcome must retain its exact artifact owner');
  const eventType = row
    ? row.event_type
    : (value as Extract<ArtifactAttemptInput, { action: 'clear' }>).eventType;
  const idempotencyKey = row
    ? row.idempotency_key
    : (value as Extract<ArtifactAttemptInput, { action: 'clear' }>).idempotencyKey;
  if (ctx.sourceKind === 'authored')
    refuseJsonBytes(Buffer.from(canonicalJson({ eventType, idempotencyKey })), ctx.secretAllow);
  const prepared = Object.freeze({ kind: 'prepared-artifact-attempt' as const });
  attemptPreparations.set(
    prepared,
    freeze({ ...record, kind: 'attempt', action: value.action, eventType, idempotencyKey, row })
  );
  return prepared;
}
export function prepareAuthoredLifecycleCompletion(
  input: LifecycleCompletionInput,
  options: CaptureAuthoredOptions
): PreparedLifecycleCompletion {
  return lifecycle(input, context('authored', options));
}
export function prepareHistoricalLifecycleCompletion(
  input: LifecycleCompletionInput,
  options: CaptureHistoricalOptions
): PreparedLifecycleCompletion {
  return lifecycle(input, context('historical', options));
}
export function prepareAuthoredArtifactAttempt(
  input: ArtifactAttemptInput,
  options: CaptureAuthoredOptions
): PreparedArtifactAttempt {
  return attempt(input, context('authored', options));
}
export function prepareHistoricalArtifactAttempt(
  input: ArtifactAttemptInput,
  options: CaptureHistoricalOptions
): PreparedArtifactAttempt {
  return attempt(input, context('historical', options));
}
export function lifecycleCompletionPreparation(
  input: PreparedLifecycleCompletion
): LifecycleCompletionPreparation {
  const value = lifecyclePreparations.get(input);
  if (!value) invalid('Use genuine prepared lifecycle completion input');
  return value;
}
export function artifactAttemptPreparation(
  input: PreparedArtifactAttempt
): ArtifactAttemptPreparation {
  const value = attemptPreparations.get(input);
  if (!value) invalid('Use genuine prepared artifact attempt input');
  return value;
}

const PlanIdempotencyRowSchema = z.strictObject({
  idempotency_key: text,
  artifact_id: UuidV7Schema,
  created_at: text,
});
const PlanIdempotencyInputSchema = RecordInputSchema.omit({
  revisionId: true,
  expectedSelection: true,
});
const CommitObjectSchema = z.strictObject({
  commitOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  commitBytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
});
const AuthoredSourceTimeInputSchema = RecordInputSchema.extend({
  commitObjects: z.array(CommitObjectSchema),
});
export type PlanIdempotencyInput = z.infer<typeof PlanIdempotencyInputSchema>;
export type SourceTimeInput = z.infer<typeof RecordInputSchema>;
export type AuthoredSourceTimeInput = z.infer<typeof AuthoredSourceTimeInputSchema>;
export interface PlanIdempotencyPreparation extends RetainedCaptureBytes {
  readonly kind: 'plan-idempotency';
  readonly row: Readonly<z.infer<typeof PlanIdempotencyRowSchema>>;
}
export interface SourceTimePreparation extends RetainedCaptureRecord {
  readonly kind: 'source-time';
  readonly member: Readonly<ArtifactSourceTimeMember>;
}
export interface PreparedPlanIdempotency {
  readonly kind: 'prepared-plan-idempotency';
}
export interface PreparedSourceTime {
  readonly kind: 'prepared-source-time';
}
const planPreparations = new WeakMap<PreparedPlanIdempotency, PlanIdempotencyPreparation>();
const sourceTimePreparations = new WeakMap<PreparedSourceTime, SourceTimePreparation>();
function planIdempotency(
  input: PlanIdempotencyInput,
  ctx: PreparationContext
): PreparedPlanIdempotency {
  const value = parse(PlanIdempotencyInputSchema, input);
  const record = retained(value, value.bytes, ctx);
  const row = decode(record, PlanIdempotencyRowSchema, ctx);
  if (row.artifact_id !== value.artifactId)
    invalid('Plan idempotency must retain its exact artifact owner');
  const prepared = Object.freeze({ kind: 'prepared-plan-idempotency' as const });
  planPreparations.set(prepared, freeze({ ...record, kind: 'plan-idempotency', row }));
  return prepared;
}
function sourceTime(
  value: SourceTimeInput,
  ctx: PreparationContext,
  commitObjects?: z.infer<typeof CommitObjectSchema>[],
  retainedMember?: ArtifactSourceTimeMember
): PreparedSourceTime {
  const record = selectedRecord(value, value.bytes, ctx);
  const member = decode(record, ArtifactSourceTimeMemberSchema, ctx);
  if (member.artifact_id !== value.artifactId)
    invalid('Source chronology must retain its exact artifact owner');
  if (commitObjects !== undefined) {
    const retainedFacts = new Map(
      retainedMember?.sources.flatMap((source) =>
        source.facts.map((fact) => [fact.commit_oid, fact] as const)
      ) ?? []
    );
    const facts = new Map<string, ReturnType<typeof prepareSourceCommitTime>>();
    for (const object of commitObjects) {
      if (facts.has(object.commitOid) || !member.member_commits.includes(object.commitOid))
        invalid('Provide each retained member commit object at most once');
      try {
        facts.set(object.commitOid, prepareSourceCommitTime(object));
      } catch (cause) {
        invalid(
          'Verify original Git commit bytes and identity before publishing chronology',
          cause
        );
      }
    }
    const used = new Set<string>();
    for (const source of member.sources) {
      for (const fact of source.facts) {
        if (
          canonicalJson(
            facts.get(fact.commit_oid) ?? retainedFacts.get(fact.commit_oid) ?? null
          ) !== canonicalJson(fact)
        )
          invalid('Every authored chronology fact requires its exact original Git object');
        if (facts.has(fact.commit_oid)) used.add(fact.commit_oid);
      }
    }
    if (used.size !== facts.size)
      invalid('Git object preparation must correspond to the retained chronology facts');
  }
  const prepared = Object.freeze({ kind: 'prepared-source-time' as const });
  sourceTimePreparations.set(prepared, freeze({ ...record, kind: 'source-time', member }));
  return prepared;
}
export function prepareAuthoredPlanIdempotency(
  input: PlanIdempotencyInput,
  options: CaptureAuthoredOptions
): PreparedPlanIdempotency {
  return planIdempotency(input, context('authored', options));
}
export function prepareHistoricalPlanIdempotency(
  input: PlanIdempotencyInput,
  options: CaptureHistoricalOptions
): PreparedPlanIdempotency {
  return planIdempotency(input, context('historical', options));
}
export function prepareAuthoredSourceTime(
  input: AuthoredSourceTimeInput,
  options: CaptureAuthoredOptions
): PreparedSourceTime {
  const ctx = context('authored', options);
  const value = parse(AuthoredSourceTimeInputSchema, input);
  return sourceTime(value, ctx, value.commitObjects);
}
export function prepareHistoricalSourceTime(
  input: SourceTimeInput,
  options: CaptureHistoricalOptions
): PreparedSourceTime {
  return sourceTime(parse(RecordInputSchema, input), context('historical', options));
}
export function planIdempotencyPreparation(
  input: PreparedPlanIdempotency
): PlanIdempotencyPreparation {
  const value = planPreparations.get(input);
  if (!value) invalid('Use genuine prepared plan idempotency input');
  return value;
}
export function sourceTimePreparation(input: PreparedSourceTime): SourceTimePreparation {
  const value = sourceTimePreparations.get(input);
  if (!value) invalid('Use genuine prepared source chronology input');
  return value;
}

export function copyAuthoredSourceTimeInput(
  input: AuthoredSourceTimeInput,
  options: CaptureAuthoredOptions
) {
  const ctx = context('authored', options);
  const value = parse(AuthoredSourceTimeInputSchema, input);
  retained(value, value.bytes, ctx);
  return {
    input: {
      ...value,
      bytes: Buffer.from(value.bytes),
      commitObjects: value.commitObjects.map((object) => ({
        commitOid: object.commitOid,
        commitBytes: Buffer.from(object.commitBytes),
      })),
    },
    options: { secretAllow: [...ctx.secretAllow] },
  };
}
export function prepareSourceTimeWithRetainedFacts(
  input: AuthoredSourceTimeInput,
  options: CaptureAuthoredOptions,
  retainedMember: ArtifactSourceTimeMember | null
): PreparedSourceTime {
  const ctx = context('authored', options);
  const value = parse(AuthoredSourceTimeInputSchema, input);
  const prior =
    retainedMember === null ? undefined : parse(ArtifactSourceTimeMemberSchema, retainedMember);
  if (prior !== undefined && prior.artifact_id !== value.artifactId)
    invalid('Carry source facts only from the exact original artifact');
  return sourceTime(value, ctx, value.commitObjects, prior);
}
export function sourceTimeRecordForReplay(
  input: AuthoredSourceTimeInput,
  options: CaptureAuthoredOptions
): SourceTimePreparation {
  const value = parse(AuthoredSourceTimeInputSchema, input);
  return sourceTimePreparation(sourceTime(value, context('authored', options)));
}
