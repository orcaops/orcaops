// Opening reconsideration items, disposing of them, and reading both at a boundary.
//
// An item is the offer a consequence traversal makes: this history records a link from a change to
// this work. It is never a defect, a revision or an assignment, and neither writer here creates
// one — nothing in this module writes outside its own two tables.
//
// Two rules shape the writers. An item's identity is derived from what it is about and what caused
// it, so a repeated signal is answered with the item the store already holds and writes nothing at
// all; and a disposition is a row beside the item, so the facts an item was opened on stay exactly
// as they were retained whatever anybody decides afterwards.
//
// Neither advances the intent counter. A real change of intent makes every earlier assessment
// eligible again, and noticing that work may be worth another look is not a change of intent — a
// signal that advanced it would make itself eligible again the moment it was written.
import { z } from 'zod';

import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { writeSequencesOf } from './knowledge-read-boundary.js';
import {
  actingField,
  AlreadyRetained,
  authoredRecord,
  committedNothing,
  InstantSchema,
  invalid,
  LabelSchema,
  missing,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  publishUnlessRetained,
  RecordIdSchema,
  replayOperation,
  retriedOperation,
  secretAllowList,
} from './knowledge-record-input.js';
import { runProjectOperation } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import {
  type Actor,
  ActorSchema,
  AttributionBasisSchema,
} from '../../schema/knowledge-contract.js';
import type { KnowledgeReadRequest } from '../../schema/knowledge-resolution.js';
import { proseText } from '../../text/control-chars.js';
import { digest } from '../event-integrity.js';

/** What a traversal can reach, which is what an item can be about. */
export const RECONSIDERATION_AFFECTED_KINDS = [
  'requirement',
  'decision',
  'claim',
  'plan_event',
  'artifact',
  'assessment',
  'code_path',
] as const;

/** The three changes a consequence traversal starts from. */
export const RECONSIDERATION_CAUSE_KINDS = ['revision', 'assumption', 'implementation'] as const;

export const RECONSIDERATION_DISPOSITIONS = [
  'acknowledged',
  'reconsidered',
  'declined',
  'superseded',
] as const;

/** The dispositions after which an item has been decided, and takes no further one. */
export const RECONSIDERATION_CLOSING_DISPOSITIONS = [
  'reconsidered',
  'declined',
  'superseded',
] as const;

export type ReconsiderationDisposition = (typeof RECONSIDERATION_DISPOSITIONS)[number];

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

/**
 * The facts an item is opened on, exactly as the traversal found them.
 *
 * Storage does not know what a change or a path is — both are core's shapes — so each is carried
 * as the JSON it is and retained whole. What storage decides is that they are there, that they say
 * something, and that the identity columns beside them are lookup copies of them.
 */
export const ReconsiderationSourceSchema = z
  .object({
    affected: z.object({ kind: z.enum(RECONSIDERATION_AFFECTED_KINDS), id: LabelSchema }).strict(),
    cause: z
      .object({
        kind: z.enum(RECONSIDERATION_CAUSE_KINDS),
        /** The dedup key: the same change always produces this same string. */
        key: LabelSchema,
        change: JsonObjectSchema,
      })
      .strict(),
    reason: proseText(),
    basis: z.enum(['explicit', 'inferred']),
    path: z.array(JsonObjectSchema),
    owner: z
      .object({ name: LabelSchema, basis: AttributionBasisSchema, from: proseText() })
      .strict()
      .refine((value) => value.basis !== 'unknown', {
        message: 'an owner nobody is named for is no owner; leave it absent',
      })
      .nullable(),
    opened_at_boundary: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type ReconsiderationSource = z.infer<typeof ReconsiderationSourceSchema>;

const OutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revision'), revision_id: RecordIdSchema }).strict(),
  z.object({ kind: z.literal('assessment'), assessment_id: RecordIdSchema }).strict(),
  z.object({ kind: z.literal('unchanged') }).strict(),
]);

export type ReconsiderationOutcome = z.infer<typeof OutcomeSchema>;

/**
 * What somebody decided about an item, apart from the item. `disposed_by` is this writer's own
 * argument, as every acting party in this family is; the rest is the decision itself.
 */
export const ReconsiderationDecisionSchema = z.discriminatedUnion('disposition', [
  z
    .object({
      disposition: z.literal('acknowledged'),
      disposed_at: InstantSchema,
      disposed_by: ActorSchema,
    })
    .strict(),
  z
    .object({
      disposition: z.literal('reconsidered'),
      outcome: OutcomeSchema,
      disposed_at: InstantSchema,
      disposed_by: ActorSchema,
    })
    .strict(),
  z
    .object({
      disposition: z.literal('declined'),
      reason: proseText(),
      disposed_at: InstantSchema,
      disposed_by: ActorSchema,
    })
    .strict(),
  z
    .object({
      disposition: z.literal('superseded'),
      superseded_by_item_id: RecordIdSchema,
      disposed_at: InstantSchema,
      disposed_by: ActorSchema,
    })
    .strict(),
]);

export type ReconsiderationDecision = z.infer<typeof ReconsiderationDecisionSchema>;

const causeIdOf = (key: string): string => digest(Buffer.from(key));

/**
 * The item id, derived from what the item is about and what caused it.
 *
 * Derivation is what makes a repeated signal the same item without a lookup, and it is why the
 * identity tuple is unique in the table too: an id minted any other way would open a second item
 * for one signal, and nothing in either row would say which of the two held.
 */
export const reconsiderationItemId = (input: {
  affected: { kind: string; id: string };
  cause: { kind: string; key: string };
}): string =>
  digest(
    Buffer.from(
      canonicalJson({
        affected: { kind: input.affected.kind, id: input.affected.id },
        cause_kind: input.cause.kind,
        cause: causeIdOf(input.cause.key),
      })
    )
  );

export interface OpenReconsiderationItems {
  readonly operationId: string;
  /** One per affected item and cause. A signal the store already holds is replayed, not refused. */
  readonly items: readonly unknown[];
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type ReconsiderationItemOpening = {
  itemId: string;
  affected: { kind: string; id: string };
  causeKind: string;
  causeId: string;
  recordSha256: string;
  /** True when the store already held this item, so this call wrote nothing for it. */
  retained: boolean;
};

export type ReconsiderationOpening = {
  items: ReconsiderationItemOpening[];
  opened: number;
  retained: number;
};

interface PreparedItem {
  readonly itemId: string;
  readonly causeId: string;
  readonly source: ReconsiderationSource;
  readonly bytes: Buffer;
  readonly sha256: string;
}

function prepareItems(items: readonly unknown[], allow: readonly string[]): PreparedItem[] {
  if (!Array.isArray(items) || items.length === 0)
    invalid('Opening reconsideration items takes at least one signal');
  const prepared = new Map<string, PreparedItem>();
  for (const item of items) {
    const source = parsed(ReconsiderationSourceSchema, item, 'A reconsideration item');
    const record = authoredRecord(source, allow);
    // One signal for one affected item and cause is one item, inside this call as well as across
    // calls: a caller that offered the same signal twice gets one item, not a conflict.
    const itemId = reconsiderationItemId(source);
    if (!prepared.has(itemId))
      prepared.set(itemId, {
        itemId,
        causeId: causeIdOf(source.cause.key),
        source,
        bytes: record.bytes,
        sha256: record.sha256,
      });
  }
  return [...prepared.values()];
}

/**
 * How many ids one `IN` list carries. A `--since` sweep traverses one change per act and each
 * answer carries up to its own cap, so the signals of one call are not bounded by anything small
 * enough to hand SQLite in one statement.
 */
const IDS_PER_QUERY = 500;

const inBatches = <T>(ids: readonly string[], read: (batch: readonly string[]) => T[]): T[] => {
  const rows: T[] = [];
  for (let at = 0; at < ids.length; at += IDS_PER_QUERY)
    rows.push(...read(ids.slice(at, at + IDS_PER_QUERY)));
  return rows;
};

/** The write sequence each of these operations committed at, asked for in batches for the same reason. */
const sequencesOf = (view: ProjectReadView, operationIds: readonly string[]): Map<string, number> =>
  new Map(
    inBatches([...new Set(operationIds)], (batch) => [...writeSequencesOf(view, batch).entries()])
  );

function retainedItemIds(view: ProjectReadView, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  return new Set(
    inBatches(ids, (batch) =>
      view.all<{ item_id: string }>(
        `SELECT item_id FROM reconsideration_items WHERE item_id IN (${batch.map(() => '?').join(',')})`,
        ...batch
      )
    ).map((row) => row.item_id)
  );
}

function openingOf(
  prepared: readonly PreparedItem[],
  retained: ReadonlySet<string>
): ReconsiderationOpening {
  const items = prepared.map((entry) => ({
    itemId: entry.itemId,
    affected: { kind: entry.source.affected.kind, id: entry.source.affected.id },
    causeKind: entry.source.cause.kind,
    causeId: entry.causeId,
    recordSha256: entry.sha256,
    retained: retained.has(entry.itemId),
  }));
  return {
    items,
    opened: items.filter((entry) => !entry.retained).length,
    retained: items.filter((entry) => entry.retained).length,
  };
}

/**
 * Open one item per affected item and cause, and nothing else.
 *
 * This is the only writer of items. The worker's publication and the correction writers do not
 * open one: §5 of the plan lets a source correction schedule bounded reconsideration and forbids
 * an unlimited cascade, so a person or a skill asks for this and no settlement does it on
 * anybody's behalf.
 *
 * A signal the store already holds writes nothing — no row, no receipt, neither counter — because
 * an item's facts are the facts as of the signal that opened it. When every signal is already held
 * the operation never starts.
 */
export async function openProjectReconsiderationItems(
  handle: ProjectDatabase,
  input: OpenReconsiderationItems,
  options: ProjectOperationOptions = {}
) {
  const operationId = operationIdentity(input.operationId);
  const prepared = prepareItems(input.items, secretAllowList(input.secretAllow));
  const ids = prepared.map((entry) => entry.itemId);
  const op = {
    operationId,
    kind: 'knowledge.reconsideration.open',
    target: { items: ids },
    payload: { records: prepared.map((entry) => entry.sha256) },
    // An item designates nothing and changes nothing that stands, so there is no selection for it
    // to observe and no intent for it to change.
    expectedState: null,
    intentChange: false,
  } as const;
  if (retriedOperation(handle, operationId)) return replayOperation(handle, op, options);
  const held = new Set(handle.read((view) => [...retainedItemIds(view, ids)]).value);
  if (held.size === prepared.length) return committedNothing(handle, openingOf(prepared, held));
  return publishUnlessRetained<ReconsiderationOpening>(
    handle,
    op,
    (transaction: ProjectSettlement) => {
      const retained = retainedItemIds(transaction, ids);
      const answer = openingOf(prepared, retained);
      // Another process opened the last of them between the read above and this transaction.
      // Committing here would spend an operation on nothing, so the settlement rolls back and the
      // items it found are what the caller gets.
      if (retained.size === prepared.length) throw new AlreadyRetained(answer);
      for (const entry of prepared) {
        if (retained.has(entry.itemId)) continue;
        const { affected, cause, owner, opened_at_boundary: boundary } = entry.source;
        transaction.run(
          `INSERT INTO reconsideration_items (item_id, affected_kind, affected_id, cause_kind,
             cause_id, opened_at_boundary, owner, owner_basis, owner_from, record_bytes,
             record_sha256, operation_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          entry.itemId,
          affected.kind,
          affected.id,
          cause.kind,
          entry.causeId,
          boundary,
          owner?.name ?? null,
          owner?.basis ?? 'unknown',
          owner?.from ?? null,
          entry.bytes,
          entry.sha256,
          operationId
        );
      }
      return answer;
    },
    options
  );
}

export interface DisposeReconsiderationItem {
  readonly operationId: string;
  readonly itemId: string;
  /** The decision as authored, without `disposed_by`. */
  readonly decision: unknown;
  /** Who decided, which a publishing session will own once storage has one. */
  readonly disposedBy: Actor;
  readonly secretAllow: readonly string[];
}

export type ReconsiderationDispositionRecord = {
  itemId: string;
  position: number;
  disposition: string;
  recordSha256: string;
};

const closedAlready = (): never => {
  throw new ProjectDatabaseError(
    'INVALID_INPUT',
    'That reconsideration item has already been reconsidered, declined or superseded; its ' +
      'disposition is retained and it takes no second one'
  );
};

const CLOSED_DISPOSITION = `SELECT position FROM reconsideration_dispositions
   WHERE item_id=? AND disposition IN ('reconsidered','declined','superseded') LIMIT 1`;

const retainedRevisionId = (view: ProjectReadView, revisionId: string): boolean =>
  !!view.get(
    `SELECT revision_id FROM requirement_revisions WHERE revision_id=?
     UNION ALL SELECT revision_id FROM decision_revisions WHERE revision_id=?
     UNION ALL SELECT revision_id FROM claim_revisions WHERE revision_id=?`,
    revisionId,
    revisionId,
    revisionId
  );

/**
 * Append what somebody decided about an item.
 *
 * The item's own row is never touched: its facts are the source facts, and a decision about them
 * is a record of its own. An unknown item is refused by name, and so is one that has already been
 * reconsidered, declined or superseded — a second decision about one item would leave nothing in
 * either row saying which of them holds. Acknowledging is not deciding, so it closes nothing and
 * several people may do it.
 */
export async function disposeProjectReconsiderationItem(
  handle: ProjectDatabase,
  input: DisposeReconsiderationItem,
  options: ProjectOperationOptions = {}
) {
  const operationId = operationIdentity(input.operationId);
  const itemId = parsed(RecordIdSchema, input.itemId, 'A reconsideration item id');
  const decision = parsed(
    ReconsiderationDecisionSchema,
    actingField(input.decision, 'disposed_by', input.disposedBy),
    'A reconsideration disposition'
  );
  const disposedBy = decision.disposed_by;
  if (decision.disposition === 'superseded' && decision.superseded_by_item_id === itemId)
    invalid('An item is superseded by another item, never by itself');
  const record = authoredRecord(decision, secretAllowList(input.secretAllow));
  const op = {
    operationId,
    kind: 'knowledge.reconsideration.dispose',
    target: { itemId },
    payload: { record: record.sha256 },
    expectedState: null,
    intentChange: false,
  } as const;
  if (retriedOperation(handle, operationId)) return replayOperation(handle, op, options);
  const check = (view: ProjectReadView): void => {
    if (!view.get('SELECT item_id FROM reconsideration_items WHERE item_id=?', itemId))
      missing('That reconsideration item is not one this history holds');
    if (view.get(CLOSED_DISPOSITION, itemId)) closedAlready();
    if (
      decision.disposition === 'superseded' &&
      !view.get(
        'SELECT item_id FROM reconsideration_items WHERE item_id=?',
        decision.superseded_by_item_id
      )
    )
      missing('The superseding reconsideration item is not one this history holds');
    if (decision.disposition === 'reconsidered') {
      const { outcome } = decision;
      if (outcome.kind === 'revision' && !retainedRevisionId(view, outcome.revision_id))
        missing('The named outcome revision is not one this history holds');
      if (
        outcome.kind === 'assessment' &&
        !view.get(
          'SELECT assessment_id FROM knowledge_assessments WHERE assessment_id=?',
          outcome.assessment_id
        )
      )
        missing('The named outcome assessment is not one this history holds');
    }
  };
  handle.read((view) => {
    check(view);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement): ReconsiderationDispositionRecord => {
      check(transaction);
      const outcome = decision.disposition === 'reconsidered' ? decision.outcome : null;
      // The position is the store's, as a decision revision's is: nothing in the decision names an
      // order, and two callers appending at once must not land on one index.
      const highest = transaction.get<{ highest: number | null }>(
        'SELECT max(position) AS highest FROM reconsideration_dispositions WHERE item_id=?',
        itemId
      );
      const position = highest === null || highest.highest === null ? 0 : highest.highest + 1;
      transaction.run(
        `INSERT INTO reconsideration_dispositions (item_id, position, disposition, outcome_kind,
           outcome_id, reason, superseded_by_item_id, disposed_by, disposed_by_basis, disposed_at,
           record_bytes, record_sha256, operation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        itemId,
        position,
        decision.disposition,
        outcome === null ? null : outcome.kind,
        outcome === null || outcome.kind === 'unchanged'
          ? null
          : outcome.kind === 'revision'
            ? outcome.revision_id
            : outcome.assessment_id,
        decision.disposition === 'declined' ? decision.reason : null,
        decision.disposition === 'superseded' ? decision.superseded_by_item_id : null,
        disposedBy.identity,
        disposedBy.basis,
        decision.disposed_at,
        record.bytes,
        record.sha256,
        operationId
      );
      return {
        itemId,
        position,
        disposition: decision.disposition,
        recordSha256: record.sha256,
      };
    },
    options
  );
}

// ── reading ─────────────────────────────────────────────────────────────────

export interface ProjectReconsiderationDisposition {
  readonly position: number;
  readonly disposition: ReconsiderationDisposition;
  readonly outcome: ReconsiderationOutcome | null;
  readonly reason: string | null;
  readonly supersededByItemId: string | null;
  readonly disposedBy: string | null;
  readonly disposedByBasis: string;
  readonly disposedAt: string;
  readonly writeSequence: number;
}

export interface ProjectReconsiderationItem {
  readonly itemId: string;
  readonly affected: { readonly kind: string; readonly id: string };
  readonly causeKind: string;
  readonly causeId: string;
  readonly openedAtBoundary: number;
  readonly owner: { readonly name: string; readonly basis: string; readonly from: string } | null;
  /** The facts the item was opened on, exactly as they were retained. */
  readonly source: unknown;
  readonly recordSha256: string;
  readonly writeSequence: number;
  /** Every disposition visible at this read's boundary, in the order they were appended. */
  readonly dispositions: readonly ProjectReconsiderationDisposition[];
  /** False once a disposition visible here reconsidered, declined or superseded it. */
  readonly open: boolean;
}

export interface ProjectReconsiderationItems {
  readonly items: readonly ProjectReconsiderationItem[];
  /** Items published after the boundary, counted rather than folded into the answer. */
  readonly later: number;
  /** Items left out because this answer carries at most `maxItems`. */
  readonly truncated: number;
}

interface ItemRow {
  item_id: string;
  affected_kind: string;
  affected_id: string;
  cause_kind: string;
  cause_id: string;
  opened_at_boundary: number;
  owner: string | null;
  owner_basis: string;
  owner_from: string | null;
  record_hex: string;
  record_sha256: string;
  operation_id: string;
}

interface DispositionRow {
  item_id: string;
  position: number;
  disposition: string;
  outcome_kind: string | null;
  outcome_id: string | null;
  reason: string | null;
  superseded_by_item_id: string | null;
  disposed_by: string | null;
  disposed_by_basis: string;
  disposed_at: string;
  operation_id: string;
}

const ITEM_COLUMNS = `SELECT item_id, affected_kind, affected_id, cause_kind, cause_id,
    opened_at_boundary, owner, owner_basis, owner_from, hex(record_bytes) AS record_hex,
    record_sha256, operation_id
  FROM reconsideration_items`;

// Ordered by the index that leads with the boundary an item was opened at, so a listing of every
// item is an ordered walk of an index rather than a sort of the table.
const ITEMS_BY_OPENED = `${ITEM_COLUMNS} ORDER BY opened_at_boundary, item_id`;
const ITEMS_BY_AFFECTED = `${ITEM_COLUMNS} WHERE affected_kind=? AND affected_id=?
  ORDER BY affected_kind, affected_id, cause_kind, cause_id`;
const ITEM_BY_ID = `${ITEM_COLUMNS} WHERE item_id=?`;

const outcomeOf = (row: DispositionRow): ReconsiderationOutcome | null => {
  if (row.outcome_kind === null) return null;
  if (row.outcome_kind === 'revision')
    return { kind: 'revision', revision_id: row.outcome_id as string };
  if (row.outcome_kind === 'assessment')
    return { kind: 'assessment', assessment_id: row.outcome_id as string };
  return { kind: 'unchanged' };
};

const CLOSING = new Set<string>(RECONSIDERATION_CLOSING_DISPOSITIONS);

function dispositionsOf(
  view: ProjectReadView,
  itemIds: readonly string[],
  boundary: number
): Map<string, ProjectReconsiderationDisposition[]> {
  const held = new Map<string, ProjectReconsiderationDisposition[]>();
  if (itemIds.length === 0) return held;
  const rows = inBatches(itemIds, (batch) =>
    view.all<DispositionRow>(
      `SELECT item_id, position, disposition, outcome_kind, outcome_id, reason,
         superseded_by_item_id, disposed_by, disposed_by_basis, disposed_at, operation_id
       FROM reconsideration_dispositions
       WHERE item_id IN (${batch.map(() => '?').join(',')})
       ORDER BY item_id, position`,
      ...batch
    )
  );
  const sequences = sequencesOf(
    view,
    rows.map((row) => row.operation_id)
  );
  for (const row of rows) {
    const writeSequence = sequences.get(row.operation_id);
    // A row published after the boundary is not one anybody had decided then. The filter is on the
    // input: an answer that showed the item and dropped its disposition would report an item as
    // still open at a boundary where it was not.
    if (writeSequence === undefined || writeSequence > boundary) continue;
    const entry: ProjectReconsiderationDisposition = {
      position: row.position,
      disposition: row.disposition as ReconsiderationDisposition,
      outcome: outcomeOf(row),
      reason: row.reason,
      supersededByItemId: row.superseded_by_item_id,
      disposedBy: row.disposed_by,
      disposedByBasis: row.disposed_by_basis,
      disposedAt: row.disposed_at,
      writeSequence,
    };
    const list = held.get(row.item_id);
    if (list === undefined) held.set(row.item_id, [entry]);
    else list.push(entry);
  }
  return held;
}

const itemOf = (
  row: ItemRow,
  writeSequence: number,
  dispositions: readonly ProjectReconsiderationDisposition[]
): ProjectReconsiderationItem => ({
  itemId: row.item_id,
  affected: { kind: row.affected_kind, id: row.affected_id },
  causeKind: row.cause_kind,
  causeId: row.cause_id,
  openedAtBoundary: row.opened_at_boundary,
  owner:
    row.owner === null
      ? null
      : { name: row.owner, basis: row.owner_basis, from: row.owner_from ?? '' },
  source: JSON.parse(Buffer.from(row.record_hex, 'hex').toString('utf8')) as unknown,
  recordSha256: row.record_sha256,
  writeSequence,
  dispositions,
  open: !dispositions.some((entry) => CLOSING.has(entry.disposition)),
});

export interface ReconsiderationReadRequest {
  /** Only the items about this affected thing; absent, every item at the boundary. */
  readonly affected?: { readonly kind: string; readonly id: string };
  /** Absent or true, only the items nothing has decided yet. */
  readonly openOnly?: boolean;
  readonly maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 100;

/**
 * The items at a boundary, with the dispositions that had been appended by then.
 *
 * Both filters are on the input, which is what makes a read at an earlier boundary an answer about
 * then rather than a shortened answer about now: an item opened afterwards is not here, and a
 * disposition appended afterwards has not happened yet, so an item decided today reads as open at
 * a boundary before the decision.
 */
export function readProjectReconsiderationItems(
  view: ProjectReadView,
  request: KnowledgeReadRequest,
  input: ReconsiderationReadRequest = {}
): ProjectReconsiderationItems {
  const boundary = request.knowledge_boundary;
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;
  const rows =
    input.affected === undefined
      ? view.all<ItemRow>(ITEMS_BY_OPENED)
      : view.all<ItemRow>(ITEMS_BY_AFFECTED, input.affected.kind, input.affected.id);
  const sequences = sequencesOf(
    view,
    rows.map((row) => row.operation_id)
  );
  const visible: { row: ItemRow; writeSequence: number }[] = [];
  let later = 0;
  for (const row of rows) {
    const writeSequence = sequences.get(row.operation_id);
    if (writeSequence === undefined) continue;
    if (writeSequence > boundary) later += 1;
    else visible.push({ row, writeSequence });
  }
  const dispositions = dispositionsOf(
    view,
    visible.map((entry) => entry.row.item_id),
    boundary
  );
  const items: ProjectReconsiderationItem[] = [];
  let truncated = 0;
  for (const { row, writeSequence } of visible) {
    const item = itemOf(row, writeSequence, dispositions.get(row.item_id) ?? []);
    if (input.openOnly !== false && !item.open) continue;
    if (items.length >= maxItems) truncated += 1;
    else items.push(item);
  }
  return { items, later, truncated };
}

/** One item by its id at a boundary, or null when this read holds no record of it. */
export function readProjectReconsiderationItem(
  view: ProjectReadView,
  itemId: string,
  request: KnowledgeReadRequest
): ProjectReconsiderationItem | null {
  const row = view.get<ItemRow>(ITEM_BY_ID, itemId);
  if (row === null) return null;
  const writeSequence = sequencesOf(view, [row.operation_id]).get(row.operation_id);
  if (writeSequence === undefined || writeSequence > request.knowledge_boundary) return null;
  return itemOf(
    row,
    writeSequence,
    dispositionsOf(view, [row.item_id], request.knowledge_boundary).get(row.item_id) ?? []
  );
}
