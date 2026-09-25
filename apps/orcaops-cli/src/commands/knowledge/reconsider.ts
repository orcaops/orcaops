// `orcaops knowledge reconsider` — the items a change leaves open, and what somebody decided
// about them.
//
// `open` is the only writer of items anywhere in this product. The worker's publication and the
// correction writers do not open one: §5 of the plan lets a source correction schedule bounded
// reconsideration and forbids an unlimited cascade, so a person or a skill asks for this and no
// settlement does it on anybody's behalf. It writes items and nothing else — no defect, no
// revision, no assignment, no processing job, no evaluator run.
//
// `list` is a passive read. `dispose` appends one row beside an item and never touches the item:
// the facts it was opened on are retained exactly as they were, whatever anybody decides.
import {
  type ConsequenceBounds,
  type ConsequenceLimit,
  RECONSIDERATION_STATEMENT,
  type ReconsiderationSignal,
  reconsiderationSignalsOfAll,
  traceConsequences,
} from '@orcaops/core';
import { type Actor, type AuthorityScope, uuidv7 } from '@orcaops/storage';
import {
  disposeProjectReconsiderationItem,
  knowledgeReadRequest,
  openProjectDatabase,
  openProjectReconsiderationItems,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  type ProjectReconsiderationItem,
  readProjectReconsiderationItems,
  reconsiderationItemId,
} from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { resolveDatabaseHistoryCommandContext } from '../../lib/database-history-context.js';
import { readConsequenceFacts } from '../../lib/knowledge-consequences-facts.js';
import {
  askedChange,
  boundedNumber,
  consequenceBounds,
  consequenceChangesOf,
  consequenceIdentityOf,
  knowledgeBoundaryAsked,
} from '../../lib/knowledge-consequences-request.js';
import { processingActor } from '../../lib/knowledge-processing-actor.js';
import {
  formatReconsiderationList,
  formatReconsiderationOpening,
} from '../../lib/knowledge-reconsideration-output.js';

export interface KnowledgeReconsiderOpenOptions {
  identity?: string;
  revision?: string;
  touching?: string;
  since?: string;
  atBoundary?: string;
  depth?: string;
  limit?: string;
  json?: boolean;
}

export interface KnowledgeReconsiderListOptions {
  identity?: string;
  /** The default, and sayable: only the items nothing has decided yet. */
  open?: boolean;
  all?: boolean;
  atBoundary?: string;
  limit?: string;
  json?: boolean;
}

export interface KnowledgeReconsiderDisposeOptions {
  acknowledge?: boolean;
  reconsidered?: string;
  decline?: string;
  supersededBy?: string;
  at?: string;
  json?: boolean;
}

const DEFAULT_LISTED = 50;
const MAX_LISTED = 500;

export interface ReconsiderationBasis {
  scope: AuthorityScope;
  mode: 'current' | 'historical';
  knowledge_boundary: number;
}

export interface ReconsiderationOpenReport {
  basis: ReconsiderationBasis & { bounds: ConsequenceBounds };
  /** Items this call wrote. */
  opened: number;
  /** Items the store already held, which this call left exactly as they were. */
  retained: number;
  items: readonly {
    item_id: string;
    affected: { kind: string; id: string };
    cause_kind: string;
    reason: string;
    owner: { name: string; basis: string; from: string } | null;
    retained: boolean;
  }[];
  limits: readonly ConsequenceLimit[];
  coverage: { statement: string };
}

export interface ReconsiderationListReport {
  basis: ReconsiderationBasis;
  items: readonly ProjectReconsiderationItem[];
  /** Items opened after the boundary, counted rather than folded into the answer. */
  later: number;
  truncated: number;
  coverage: { statement: string };
}

/** The one place a local act learns who is acting: the account, never `authenticated`. */
const invokingActor = (): Actor => {
  const actor = processingActor();
  return { identity: actor.changedBy, basis: actor.changedByBasis };
};

interface ProjectTarget {
  authority: ProjectDatabaseAuthority;
  scope: AuthorityScope;
}

async function resolveProject(): Promise<ProjectTarget> {
  const context = await resolveDatabaseHistoryCommandContext({
    profile: 'status',
    selector: { scope: 'project' },
  });
  try {
    const project = context.scope.projects[0];
    const authority = project?.authority ?? null;
    if (!project?.database || authority === null)
      throw new OrcaopsError(
        ErrorCodes.UNINITIALIZED,
        project?.completeness.issues[0]?.message ??
          'This repository has no orcaops project history to reconsider anything in yet.'
      );
    return {
      authority: { ...authority },
      scope: { kind: 'project', project_id: authority.projectId },
    };
  } finally {
    context.scope.close();
  }
}

async function withProject<T>(use: (target: ProjectTarget, handle: ProjectDatabase) => Promise<T>) {
  const target = await resolveProject();
  const handle = await openProjectDatabase({ authority: target.authority, mode: 'writer' });
  try {
    return await use(target, handle);
  } finally {
    handle.close();
  }
}

/**
 * `orcaops knowledge reconsider open` — traverse one change and retain one item per affected item
 * and cause.
 *
 * The traversal is the same one `knowledge consequences` runs, on the same flags. What this verb
 * adds is the record: an offer that this work may be worth another look, with the cause, the path
 * and the owner the traversal found. It opens nothing else.
 */
export async function knowledgeReconsiderOpenAction(
  opts: KnowledgeReconsiderOpenOptions = {}
): Promise<void> {
  const json = opts.json === true;
  try {
    const asked = askedChange(opts);
    const bounds = consequenceBounds(opts);
    const boundary = knowledgeBoundaryAsked(opts.atBoundary);
    const mode = boundary === 'now' ? ('current' as const) : ('historical' as const);
    const report = await withProject(async (target, handle) => {
      const traced = handle.read((view) => {
        const request = knowledgeReadRequest(view, { scope: target.scope, mode, boundary });
        const { changes, limits } = consequenceChangesOf(view, asked, request, bounds);
        return {
          knowledgeBoundary: request.knowledge_boundary,
          limits,
          answers: changes.map((change) =>
            traceConsequences(
              change,
              readConsequenceFacts(view, {
                projectId: target.authority.projectId,
                scope: target.scope,
                boundary: request.knowledge_boundary,
                mode,
                change,
                bounds,
                // This verb reads no processing state. A claim about what has been interpreted is
                // one `orcaops knowledge status` makes, and it could not change which links this
                // history records anyway.
                processing: null,
              }),
              bounds
            )
          ),
        };
      }).value;
      const signals = reconsiderationSignalsOfAll(traced.answers);
      const basis = {
        scope: target.scope,
        mode,
        knowledge_boundary: traced.knowledgeBoundary,
        bounds,
      };
      const limits = [...traced.limits, ...traced.answers.flatMap((answer) => answer.limits)];
      if (signals.length === 0)
        return {
          basis,
          opened: 0,
          retained: 0,
          items: [],
          limits,
          coverage: { statement: RECONSIDERATION_STATEMENT },
        } satisfies ReconsiderationOpenReport;
      const written = await openProjectReconsiderationItems(handle, {
        operationId: uuidv7(),
        items: signals.map(sourceOf),
        secretAllow: [],
      });
      // Keyed by the id the store derives, not by position: the writer deduplicates too, so an
      // index into the signals would be the wrong signal the moment a caller offered one twice.
      const byId = new Map(
        signals.map((signal) => [reconsiderationItemId(signal), signal] as const)
      );
      return {
        basis,
        opened: written.value.opened,
        retained: written.value.retained,
        items: written.value.items.map((entry) => ({
          item_id: entry.itemId,
          affected: entry.affected,
          cause_kind: entry.causeKind,
          reason: byId.get(entry.itemId)?.reason ?? '',
          owner: byId.get(entry.itemId)?.owner ?? null,
          retained: entry.retained,
        })),
        limits,
        coverage: { statement: RECONSIDERATION_STATEMENT },
      } satisfies ReconsiderationOpenReport;
    });
    if (json) {
      emitOk({ ...report });
      return;
    }
    writeTerminalSafeStdout(formatReconsiderationOpening(report));
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

/** The signal as the store retains it: the facts, and nothing this command decided. */
const sourceOf = (signal: ReconsiderationSignal) => ({
  affected: signal.affected,
  cause: signal.cause,
  reason: signal.reason,
  basis: signal.basis,
  path: signal.path,
  owner: signal.owner,
  opened_at_boundary: signal.openedAtBoundary,
});

/**
 * `orcaops knowledge reconsider list` — the items at a boundary, with the latest disposition of
 * each. A passive read: it opens nothing, decides nothing and writes nothing.
 */
export async function knowledgeReconsiderListAction(
  opts: KnowledgeReconsiderListOptions = {}
): Promise<void> {
  const json = opts.json === true;
  try {
    if (opts.open === true && opts.all === true)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Ask for one: `--open` for the items nothing has decided, or `--all` for those too',
        'open'
      );
    const boundary = knowledgeBoundaryAsked(opts.atBoundary);
    const mode = boundary === 'now' ? ('current' as const) : ('historical' as const);
    const maxItems =
      opts.limit === undefined
        ? DEFAULT_LISTED
        : boundedNumber(opts.limit, { min: 1, max: MAX_LISTED }, '--limit');
    const affected =
      opts.identity === undefined
        ? undefined
        : identityAsAffected(consequenceIdentityOf(opts.identity, '--identity'));
    const context = await resolveDatabaseHistoryCommandContext({
      profile: 'status',
      selector: { scope: 'project' },
    });
    let report: ReconsiderationListReport;
    try {
      const project = context.scope.projects[0];
      const authority = project?.authority ?? null;
      if (!project?.database || authority === null)
        throw new OrcaopsError(
          ErrorCodes.UNINITIALIZED,
          project?.completeness.issues[0]?.message ??
            'This repository has no orcaops project history to reconsider anything in yet.'
        );
      const scope: AuthorityScope = { kind: 'project', project_id: authority.projectId };
      report = project.database.read((view) => {
        const request = knowledgeReadRequest(view, { scope, mode, boundary });
        const read = readProjectReconsiderationItems(view, request, {
          ...(affected === undefined ? {} : { affected }),
          openOnly: opts.all !== true,
          maxItems,
        });
        return {
          basis: { scope, mode, knowledge_boundary: request.knowledge_boundary },
          items: read.items,
          later: read.later,
          truncated: read.truncated,
          coverage: { statement: RECONSIDERATION_STATEMENT },
        } satisfies ReconsiderationListReport;
      }).value;
    } finally {
      context.scope.close();
    }
    if (json) {
      emitOk({ ...report });
      return;
    }
    writeTerminalSafeStdout(formatReconsiderationList(report));
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

const identityAsAffected = (identity: { kind: string; entity_id: string }) => ({
  kind: identity.kind,
  id: identity.entity_id,
});

function decisionOf(opts: KnowledgeReconsiderDisposeOptions, at: string): Record<string, unknown> {
  const named = [
    opts.acknowledge === true ? 'acknowledge' : null,
    opts.reconsidered === undefined ? null : 'reconsidered',
    opts.decline === undefined ? null : 'decline',
    opts.supersededBy === undefined ? null : 'superseded-by',
  ].filter((value) => value !== null);
  if (named.length !== 1)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Give one disposition: `--acknowledge`, `--reconsidered <outcome>`, `--decline <reason>` ' +
        'or `--superseded-by <item>`',
      'acknowledge'
    );
  if (opts.acknowledge === true) return { disposition: 'acknowledged', disposed_at: at };
  if (opts.decline !== undefined)
    return { disposition: 'declined', reason: opts.decline, disposed_at: at };
  if (opts.supersededBy !== undefined)
    return {
      disposition: 'superseded',
      superseded_by_item_id: opts.supersededBy,
      disposed_at: at,
    };
  return {
    disposition: 'reconsidered',
    outcome: outcomeOf(opts.reconsidered as string),
    disposed_at: at,
  };
}

/** `unchanged`, or the record the reconsideration produced, named by kind so nothing is guessed. */
function outcomeOf(value: string): Record<string, unknown> {
  if (value === 'unchanged') return { kind: 'unchanged' };
  const at = value.indexOf(':');
  const kind = at < 0 ? '' : value.slice(0, at);
  const id = at < 0 ? '' : value.slice(at + 1);
  if (kind === 'revision' && id.length > 0) return { kind: 'revision', revision_id: id };
  if (kind === 'assessment' && id.length > 0) return { kind: 'assessment', assessment_id: id };
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    '--reconsidered names what came of it: `unchanged`, `revision:<id>` or `assessment:<id>`',
    'reconsidered'
  );
}

/**
 * `orcaops knowledge reconsider dispose <item>` — append what somebody decided.
 *
 * The item is never edited: the decision is a row beside it, carrying who decided and when, so the
 * facts the item was opened on and what became of it are always two separate readings.
 */
export async function knowledgeReconsiderDisposeAction(
  itemId: string,
  opts: KnowledgeReconsiderDisposeOptions = {}
): Promise<void> {
  const json = opts.json === true;
  try {
    const at = opts.at ?? new Date().toISOString();
    const decision = decisionOf(opts, at);
    const operationId = uuidv7();
    const written = await withProject(async (_target, handle) =>
      disposeProjectReconsiderationItem(handle, {
        operationId,
        itemId,
        decision,
        disposedBy: invokingActor(),
        secretAllow: [],
      })
    );
    if (json) {
      emitOk({
        item_id: written.value.itemId,
        position: written.value.position,
        disposition: written.value.disposition,
        record_sha256: written.value.recordSha256,
        operation_id: operationId,
        counters: written.counters,
      });
      return;
    }
    writeTerminalSafeStdout(
      `Recorded ${written.value.disposition} for reconsideration item ${written.value.itemId}.\n` +
        'The item itself is unchanged: what it was opened on is retained, and this decision is a ' +
        'record of its own beside it.\n'
    );
  } catch (err) {
    if (json) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
