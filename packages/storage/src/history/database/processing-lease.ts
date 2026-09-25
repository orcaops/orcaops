// The single worker lease. It schedules this optional worker and nothing else: it is no general
// lock, and it grants no authority over Git, Cloud, evaluator or capture operations. Its owner
// generation is the fence every other scheduling write names, so a worker that lost the lease
// cannot claim, reserve, heartbeat or settle afterwards. Time is always a parameter.
import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  processingBound,
  processingGeneration,
  processingInstant,
  type ProcessingMaintenance,
  processingText,
  runProcessingMaintenance,
} from './processing-maintenance.js';
import type { ProjectOperationOptions } from './transactions.js';

export interface ProcessingLease {
  ownerGeneration: number;
  ownerId: string | null;
  acquiredAt: string | null;
  renewedAt: string | null;
  expiresAt: string | null;
}

const LEASE_COLUMNS = `owner_generation AS ownerGeneration, owner_id AS ownerId,
  acquired_at AS acquiredAt, renewed_at AS renewedAt, expires_at AS expiresAt`;

function readLease(view: ProjectReadView): ProcessingLease | null {
  const row = view.get<ProcessingLease>(
    `SELECT ${LEASE_COLUMNS} FROM processing_lease WHERE singleton=1`
  );
  if (!row) return null;
  if (!Number.isSafeInteger(row.ownerGeneration) || row.ownerGeneration < 1)
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The retained processing lease has an invalid owner generation; explicit repair is required'
    );
  return { ...row };
}

/** The lease as it stands. Reads only; no row is created by looking. */
export function readProcessingLease(handle: ProjectDatabase): ProcessingLease | null {
  assertProjectDatabasePath(handle);
  return handle.read(readLease).value;
}

/**
 * The fence. Every scheduling write but the pause and the model resume passes
 * through here first, so a superseded worker is refused with nothing written.
 */
export function assertProcessingLeaseGeneration(
  view: ProjectReadView,
  generation: number
): ProcessingLease {
  const wanted = processingGeneration(generation, 'the lease generation');
  const lease = readLease(view);
  if (!lease || lease.ownerId === null || lease.ownerGeneration !== wanted)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      'The processing lease is no longer held under this generation; take the lease again before writing'
    );
  return lease;
}

export type ProcessingLeaseTake =
  | { outcome: 'taken'; lease: ProcessingLease }
  | { outcome: 'held_by_other'; lease: ProcessingLease };

export interface TakeProcessingLease {
  ownerId: string;
  now: string;
  expiresAt: string;
  /** The longest term this lease may be held for; expiry is what breaks it. */
  maxTermMs: number;
}

/**
 * A lease taken for a thousand years is a lease nobody can break, so the term
 * is bounded by a ceiling its caller passes. The worker passes a small multiple
 * of its heartbeat, which makes a lapsed owner's lease expire while a live one
 * keeps renewing.
 */
function leaseTerm(now: string, expiresAt: string, maxTermMs: unknown, verb: string): void {
  const term = Date.parse(expiresAt) - Date.parse(now);
  if (term <= 0)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      `A processing lease expires after the moment it is ${verb}`
    );
  if (term > processingBound(maxTermMs, 'the longest lease term'))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'A processing lease is held for no longer than the term its caller allows'
    );
}

function writeLease(
  transaction: ProcessingMaintenance,
  present: boolean,
  lease: ProcessingLease
): ProcessingLease {
  const changes = present
    ? transaction.run(
        `UPDATE processing_lease SET owner_generation=?, owner_id=?, acquired_at=?, renewed_at=?, expires_at=?
          WHERE singleton=1`,
        lease.ownerGeneration,
        lease.ownerId,
        lease.acquiredAt,
        lease.renewedAt,
        lease.expiresAt
      ).changes
    : transaction.run(
        'INSERT INTO processing_lease (singleton,owner_generation,owner_id,acquired_at,renewed_at,expires_at) VALUES (1,?,?,?,?,?)',
        lease.ownerGeneration,
        lease.ownerId,
        lease.acquiredAt,
        lease.renewedAt,
        lease.expiresAt
      ).changes;
  if (changes !== 1)
    throw new ProjectDatabaseError(
      'TRANSACTION_FAILED',
      'The processing lease row did not change; inspect storage before retrying'
    );
  return lease;
}

/**
 * Take the lease when it is free or expired, always under a generation strictly
 * greater than any before it. A second taker while it is held and unexpired
 * loses and is told so; losing a start-up race is an ordinary outcome for a
 * worker, not a failure of the store.
 */
export async function takeProcessingLease(
  handle: ProjectDatabase,
  input: TakeProcessingLease,
  options: ProjectOperationOptions = {}
): Promise<ProcessingLeaseTake> {
  const ownerId = processingText(input.ownerId, 'the worker owner id');
  const now = processingInstant(input.now, 'the current time');
  const expiresAt = processingInstant(input.expiresAt, 'the lease expiry');
  leaseTerm(now, expiresAt, input.maxTermMs, 'taken');
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.lease.take',
    (transaction) => {
      const current = readLease(transaction);
      if (current && current.ownerId !== null && Date.parse(current.expiresAt!) > Date.parse(now))
        return { outcome: 'held_by_other' as const, lease: current };
      const ownerGeneration = (current?.ownerGeneration ?? 0) + 1;
      if (!Number.isSafeInteger(ownerGeneration))
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'Processing lease generation capacity is exhausted; explicit repair is required'
        );
      return {
        outcome: 'taken' as const,
        lease: writeLease(transaction, current !== null, {
          ownerGeneration,
          ownerId,
          acquiredAt: now,
          renewedAt: now,
          expiresAt,
        }),
      };
    },
    options
  );
}

export interface RenewProcessingLease {
  ownerId: string;
  generation: number;
  now: string;
  expiresAt: string;
  maxTermMs: number;
}

/** Renew only as the current owner under the current generation. */
export async function renewProcessingLease(
  handle: ProjectDatabase,
  input: RenewProcessingLease,
  options: ProjectOperationOptions = {}
): Promise<ProcessingLease> {
  const ownerId = processingText(input.ownerId, 'the worker owner id');
  const generation = processingGeneration(input.generation, 'the lease generation');
  const now = processingInstant(input.now, 'the current time');
  const expiresAt = processingInstant(input.expiresAt, 'the lease expiry');
  leaseTerm(now, expiresAt, input.maxTermMs, 'renewed');
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.lease.renew',
    (transaction) => {
      const current = assertProcessingLeaseGeneration(transaction, generation);
      if (current.ownerId !== ownerId)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing lease belongs to another owner; take the lease again before renewing'
        );
      return writeLease(transaction, true, {
        ownerGeneration: current.ownerGeneration,
        ownerId,
        acquiredAt: current.acquiredAt,
        renewedAt: now,
        expiresAt,
      });
    },
    options
  );
}

export interface ReleaseProcessingLease {
  ownerId: string;
  generation: number;
}

/**
 * Give the lease up. The generation stays on the row: it only moves forward, so
 * the next taker is still strictly later than every worker before it.
 */
export async function releaseProcessingLease(
  handle: ProjectDatabase,
  input: ReleaseProcessingLease,
  options: ProjectOperationOptions = {}
): Promise<ProcessingLease> {
  const ownerId = processingText(input.ownerId, 'the worker owner id');
  const generation = processingGeneration(input.generation, 'the lease generation');
  assertProjectDatabasePath(handle);
  return runProcessingMaintenance(
    handle,
    'processing.lease.release',
    (transaction) => {
      const current = assertProcessingLeaseGeneration(transaction, generation);
      if (current.ownerId !== ownerId)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The processing lease belongs to another owner; only its owner releases it'
        );
      return writeLease(transaction, true, {
        ownerGeneration: current.ownerGeneration,
        ownerId: null,
        acquiredAt: null,
        renewedAt: null,
        expiresAt: null,
      });
    },
    options
  );
}
