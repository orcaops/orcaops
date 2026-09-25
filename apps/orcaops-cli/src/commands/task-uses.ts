import { uuidv7 } from '@orcaops/storage';
import {
  knowledgeReadRequest,
  openProjectDatabase,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  type ProjectTaskUseAtBoundary,
  readProjectTaskUsesAtBoundary,
  recordProjectTaskUses,
} from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import { readPayloadInput } from '../io/input.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../io/output.js';
import { knowledgeBoundaryOption } from '../lib/artifact-knowledge.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import { processingActor } from '../lib/knowledge-processing-actor.js';

/**
 * `orcaops task uses` — what a task did with an exact requirement or decision revision.
 *
 * The two lists are the point. A use the plan event's own operation wrote was an original
 * selection; a use any later operation wrote is a connection somebody found afterwards, and the
 * store derives which from the operations rather than taking a caller's word for it. `record`
 * always runs in an operation of its own, so what it writes is always a later connection and it
 * refuses to write one that cannot say who found it and when.
 */

interface ProjectHandle {
  handle: ProjectDatabase;
  authority: ProjectDatabaseAuthority;
}

async function withProject<T>(
  mode: 'reader' | 'writer',
  use: (project: ProjectHandle) => Promise<T> | T
): Promise<T> {
  const context = await resolveDatabaseHistoryCommandContext({
    profile: 'status',
    selector: { scope: 'project' },
  });
  let authority: ProjectDatabaseAuthority;
  try {
    const project = context.scope.projects[0];
    if (!project?.authority || !project.database)
      throw new OrcaopsError(
        ErrorCodes.UNINITIALIZED,
        project?.completeness.issues[0]?.message ??
          'This repository has no orcaops project history yet.'
      );
    authority = { ...project.authority };
  } finally {
    context.scope.close();
  }
  const handle = await openProjectDatabase({ authority, mode });
  try {
    return await use({ handle, authority });
  } finally {
    handle.close();
  }
}

const PLAN_EVENTS =
  "SELECT event_id FROM artifact_events WHERE artifact_id=? AND event_type IN ('plan_captured','plan_revised') ORDER BY ordinal";

export interface TaskUsesListOptions {
  planEvent?: string;
  artifact?: string;
  atBoundary?: string;
  json?: boolean;
}

const useReport = (entry: ProjectTaskUseAtBoundary) => ({
  artifact_id: entry.use.artifactId,
  plan_event_id: entry.use.planEventId,
  target: entry.use.target,
  role: entry.use.role,
  step_id: entry.use.stepId,
  criterion_id: entry.use.criterionId,
  exception_id: entry.use.exceptionId,
  standing: entry.standing,
  write_sequence: entry.writeSequence,
  discovered_at: entry.use.discoveredAt,
  discovered_by: entry.use.discoveredBy,
});

export async function taskUsesListAction(opts: TaskUsesListOptions = {}): Promise<void> {
  try {
    if ((opts.planEvent === undefined) === (opts.artifact === undefined))
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Name one plan event with --plan-event <id>, or one artifact with --artifact <id>',
        'plan-event'
      );
    const boundary = knowledgeBoundaryOption(opts.atBoundary);
    const report = await withProject(
      'reader',
      ({ handle, authority }) =>
        handle.read((view) => {
          const request = knowledgeReadRequest(view, {
            scope: { kind: 'project', project_id: authority.projectId },
            mode: boundary === 'now' ? 'current' : 'historical',
            boundary,
          });
          const planEvents =
            opts.planEvent === undefined
              ? view
                  .all<{ event_id: string }>(PLAN_EVENTS, opts.artifact as string)
                  .map((row) => row.event_id)
              : [opts.planEvent];
          return {
            knowledge_boundary: request.knowledge_boundary,
            plan_events: planEvents.map((planEventId) => {
              const uses = readProjectTaskUsesAtBoundary(
                view,
                planEventId,
                authority.projectId,
                request
              );
              return {
                plan_event_id: planEventId,
                selected_with_plan: uses.selectedWithPlan.map(useReport),
                connected_later: uses.connectedLater.map(useReport),
              };
            }),
          };
        }).value
    );
    if (opts.json === true) {
      emitOk(report);
      return;
    }
    writeTerminalSafeStdout(renderTaskUses(report));
  } catch (err) {
    if (opts.json === true) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

type TaskUsesReport = {
  knowledge_boundary: number;
  plan_events: {
    plan_event_id: string;
    selected_with_plan: ReturnType<typeof useReport>[];
    connected_later: ReturnType<typeof useReport>[];
  }[];
};

function renderTaskUses(report: TaskUsesReport): string {
  const lines = [`Task uses at write sequence ${report.knowledge_boundary}.`];
  for (const event of report.plan_events) {
    lines.push('', `Plan event ${event.plan_event_id}`);
    lines.push(
      event.selected_with_plan.length === 0
        ? '  Selected with the plan (0): this plan selected none.'
        : `  Selected with the plan (${event.selected_with_plan.length})`
    );
    for (const use of event.selected_with_plan)
      lines.push(
        `    - ${use.target.kind} ${use.target.entityId} revision ${use.target.revisionId} ` +
          `(${use.role}; ${use.standing})`
      );
    lines.push(
      event.connected_later.length === 0
        ? '  Connected later (0): nothing was connected after the plan.'
        : `  Connected later (${event.connected_later.length})`
    );
    for (const use of event.connected_later) {
      const who = use.discovered_by;
      lines.push(
        `    - ${use.target.kind} ${use.target.entityId} revision ${use.target.revisionId} ` +
          `(${use.role}; ${use.standing})`,
        `      found by ${who?.name ?? 'an unnamed party'} (${who?.kind ?? 'unknown'}; ` +
          `${who?.basis ?? 'unknown'}) at ${use.discovered_at}`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface TaskUsesRecordOptions {
  input?: string;
  artifact?: string;
  planEvent?: string;
  identity?: string;
  revision?: string;
  role?: string;
  step?: string;
  criterion?: string;
  exception?: string;
  discoveredAt?: string;
  discoveredBy?: string;
  json?: boolean;
  isTTY?: boolean;
}

interface RecordedInput {
  uses: unknown[];
  discovery: unknown;
}

function identityOf(value: string): { kind: string; entity_id: string } {
  const at = value.indexOf(':');
  if (at <= 0 || at === value.length - 1)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--identity takes <kind>:<id>, where kind is requirement or decision',
      'identity'
    );
  return { kind: value.slice(0, at), entity_id: value.slice(at + 1) };
}

function fromFlags(opts: TaskUsesRecordOptions): RecordedInput {
  const missing = (['artifact', 'planEvent', 'identity', 'revision', 'role'] as const).filter(
    (flag) => opts[flag] === undefined
  );
  if (missing.length > 0)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `Recording one use needs --artifact, --plan-event, --identity, --revision and --role; missing ${missing.join(', ')}`,
      missing[0] as string
    );
  const identity = identityOf(opts.identity as string);
  return {
    uses: [
      {
        artifact_id: opts.artifact,
        plan_event_id: opts.planEvent,
        target: { ...identity, revision_id: opts.revision },
        role: opts.role,
        local:
          opts.step === undefined
            ? null
            : { step_id: opts.step, criterion_id: opts.criterion ?? null },
        exception_id: opts.exception ?? null,
      },
    ],
    discovery: discoveryOf(opts),
  };
}

function discoveryOf(opts: TaskUsesRecordOptions): unknown {
  if (opts.discoveredAt === undefined || opts.discoveredBy === undefined) return null;
  return { discovered_at: opts.discoveredAt, discovered_by: { name: opts.discoveredBy } };
}

/** The name a caller offered for the discoverer, wherever the payload put it. */
function discovererName(discoveredBy: unknown): string | null {
  if (discoveredBy === null || typeof discoveredBy !== 'object') return null;
  const held = discoveredBy as Record<string, unknown>;
  if (held.kind === 'detector')
    // A detector is what background processing is attributed to. This command is somebody running
    // a command, and letting a caller record one here would put derived standing on an act a
    // person made.
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'A discovery recorded by this command is an actor’s. A detector is what background ' +
        'processing is attributed to, and nothing here is background processing.',
      'discovery'
    );
  if (typeof held.name === 'string') return held.name;
  const actor = held.actor;
  if (
    actor !== null &&
    typeof actor === 'object' &&
    typeof (actor as { identity?: unknown }).identity === 'string'
  )
    return (actor as { identity: string }).identity;
  return null;
}

/**
 * Who found the connection and when, with the attribution basis THIS COMMAND can honestly state.
 *
 * The caller supplies the name; the basis is never the caller's to give. Nothing local
 * authenticates who typed the command, so `authenticated` is a claim no invocation here can make,
 * and a payload asking for it would put an unearned standing on the record through a flag nobody
 * checks. The basis says an agent reported it on a person's instruction when an agent invoked us,
 * and otherwise that somebody asserted it — the same rule a local pause records itself under.
 */
function attributedDiscovery(discovery: unknown): unknown {
  if (discovery === null || typeof discovery !== 'object') return discovery;
  const held = discovery as Record<string, unknown>;
  const name = discovererName(held.discovered_by);
  if (name === null)
    return {
      ...held,
      discovered_by: { kind: 'actor', actor: { identity: null, basis: 'unknown' } },
    };
  const basis = processingActor().changedByBasis;
  if (basis === 'unknown')
    // An account this process cannot describe cannot say on what basis it asserts somebody else's
    // name. Refused here rather than inside the writer, where the same mismatch surfaces as a
    // schema failure with a database already open.
    throw new OrcaopsError(
      ErrorCodes.DISCOVERER_NOT_ATTRIBUTABLE,
      `This command cannot read the account it runs as, so it cannot say on what basis it ` +
        `asserts that ${name} found the connection. Record the discovery with an unknown actor ` +
        `through --input if that is what you mean; nothing local can authenticate a name.`,
      'discovered-by'
    );
  return { ...held, discovered_by: { kind: 'actor', actor: { identity: name, basis } } };
}

export async function taskUsesRecordAction(opts: TaskUsesRecordOptions = {}): Promise<void> {
  try {
    const payload =
      opts.input === undefined
        ? fromFlags(opts)
        : ((await readPayloadInput({
            inputPath: opts.input,
            ...(opts.isTTY === undefined ? {} : { isTTY: opts.isTTY }),
          })) as RecordedInput);
    if (payload.discovery === null || payload.discovery === undefined)
      // The contract's own refusal, raised before anything is opened for writing: this command
      // never runs inside the plan event's operation, so what it records is always a connection
      // found afterwards, and one that cannot say who found it and when would be indistinguishable
      // from the plan's own selection.
      throw new OrcaopsError(
        ErrorCodes.DISCOVERY_REQUIRED,
        'A use recorded after its plan event names who found the connection and when. Pass ' +
          '--discovered-at <instant> and --discovered-by <name>, or a discovery block in ' +
          '--input. A later connection is no original task selection.',
        'discovered-at'
      );
    // Whatever the payload said, the basis is this command's: see `attributedDiscovery`.
    const discovery = attributedDiscovery(payload.discovery);
    const recorded = await withProject('writer', ({ handle }) =>
      recordProjectTaskUses(handle, {
        operationId: uuidv7(),
        uses: payload.uses,
        discovery,
        secretAllow: [],
      })
    );
    const report = {
      uses: recorded.value.uses.map((use) => ({
        artifact_id: use.artifactId,
        plan_event_id: use.planEventId,
        target_revision_id: use.targetRevisionId,
        role: use.role,
        selection_kind: use.selectionKind,
        published: use.published,
      })),
    };
    if (opts.json === true) {
      emitOk(report);
      return;
    }
    writeTerminalSafeStdout(
      `${report.uses
        .map(
          (use) =>
            `Recorded ${use.selection_kind} use of revision ${use.target_revision_id} ` +
            `(${use.role}) on plan event ${use.plan_event_id}` +
            `${use.published ? '' : ' — already recorded, so nothing was written'}`
        )
        .join('\n')}\n`
    );
  } catch (err) {
    if (opts.json === true) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}
