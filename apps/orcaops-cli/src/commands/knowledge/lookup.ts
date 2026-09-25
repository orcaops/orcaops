import {
  type ApplicableNotSelected,
  applicableNotSelected,
  type KnowledgeContextAnswer,
  knowledgeContextAnswer,
  RELATED_KNOWLEDGE_SEARCH_HITS,
  RELATED_KNOWLEDGE_SEARCH_TERMS,
  RELATED_KNOWLEDGE_SOURCES_FOLLOWED,
} from '@orcaops/core';
import type { KnowledgeTarget, SelectedImplementation } from '@orcaops/storage';
import {
  type ActiveTaskSelection,
  activeTaskSelectionAtBoundary,
  type KnowledgeContextSubject,
  latestVisiblePlanEventId,
  projectKnowledgeContext,
} from '@orcaops/storage/history/database';

import { readProcessingSurface, reportProcessingConsent } from './context.js';
import { ErrorCodes, OrcaopsError } from '../../io/errors.js';
import { CliExit } from '../../io/exit.js';
import { emitError, emitOk, writeErrorLine, writeTerminalSafeStdout } from '../../io/output.js';
import { knowledgeBoundaryOption } from '../../lib/artifact-knowledge.js';
import { resolveDatabaseHistoryCommandContext } from '../../lib/database-history-context.js';
import {
  type KnowledgeAssignmentSummary,
  knowledgeAssignmentSummary,
} from '../../lib/knowledge-assignment-view.js';
import { formatKnowledgeContext } from '../../lib/knowledge-context-output.js';
import { processingActor } from '../../lib/knowledge-processing-actor.js';
import { processingCoverageOf } from '../../lib/knowledge-processing-coverage.js';
import { readProcessingHistory } from '../../lib/knowledge-processing-queue.js';
import {
  type KnowledgeReconsiderationSummary,
  knowledgeReconsiderationSummary,
} from '../../lib/knowledge-reconsideration-view.js';
import type { ActivePlanSelection } from '../../lib/plan-knowledge-uses.js';

export interface KnowledgeLookupOptions {
  text?: string;
  adopted?: boolean;
  subject?: string;
  identity?: string[];
  touching?: string;
  atBoundary?: string;
  scope?: string;
  limit?: string;
  software?: string[];
  environment?: string;
  json?: boolean;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
/** Enough for a page of statements; the identity cap is what a person's `--limit` moves. */
const MAX_STATEMENT_BYTES = 65_536;

const IDENTITY_KINDS = new Set(['requirement', 'decision', 'claim', 'relationship']);

/** The one place a local read learns who it is for: the account, never `authenticated`. */
const invokingActor = () => {
  const actor = processingActor();
  return { identity: actor.changedBy, basis: actor.changedByBasis };
};

type SelectedInput = Extract<SelectedImplementation, { kind: 'selected' }>['inputs'][number];

/** The contract's own input vocabulary. A name outside it identifies nothing this store knows. */
const INPUT_KINDS = new Set([
  'git_commit',
  'git_tree',
  'worktree_snapshot',
  'build',
  'release',
  'file',
  'evaluator_context',
]);

/**
 * The software the question is about, or `null` when nobody named any.
 *
 * Null is not `none_selected`. An answer that turned "you did not say" into "you said none" would
 * make an assessment of unidentified software apply to a question that never named a version,
 * which is the satisfaction claim against unspecified software §8 refuses.
 */
function softwareOf(opts: KnowledgeLookupOptions): SelectedImplementation | null {
  const named = opts.software ?? [];
  if (named.length === 0) {
    if (opts.environment !== undefined)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--environment names the conditions software was judged under, so it takes --software too',
        'environment'
      );
    return null;
  }
  const inputs = named.map((value) => {
    const at = value.indexOf(':');
    const kind = at < 0 ? '' : value.slice(0, at);
    const identity = at < 0 ? '' : value.slice(at + 1);
    if (!INPUT_KINDS.has(kind) || identity.length === 0)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `--software takes <kind>:<identity>, where kind is one of ${[...INPUT_KINDS].sort().join(', ')}`,
        'software'
      );
    return { kind, identity } as SelectedInput;
  });
  return { kind: 'selected', inputs, environment: opts.environment ?? null };
}

function identityOf(value: string): KnowledgeTarget {
  const at = value.indexOf(':');
  const kind = at < 0 ? '' : value.slice(0, at);
  const entityId = at < 0 ? '' : value.slice(at + 1);
  if (!IDENTITY_KINDS.has(kind) || entityId.length === 0)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `--identity takes <kind>:<id>, where kind is one of ${[...IDENTITY_KINDS].sort().join(', ')}`,
      'identity'
    );
  return { kind: kind as KnowledgeTarget['kind'], entity_id: entityId };
}

function boundedNumber(value: string, bounds: { min: number; max: number }, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `${flag} takes a whole number between ${bounds.min} and ${bounds.max}`,
      flag.replace(/^--/u, '')
    );
  return parsed;
}

function subjectOf(opts: KnowledgeLookupOptions): KnowledgeContextSubject {
  // A path locates a subject; it is not one, and nothing in this store indexes a recorded file
  // path against a continuing record. Answering it would mean scanning every artifact's touched
  // files and then guessing which of that artifact's records the path is about, which is a
  // relationship this history does not hold. `orcaops list --touching` finds the artifacts, and
  // `--identity` or `--subject` reaches the records.
  if (opts.touching !== undefined)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'This history records no attributed association between code and a continuing record, and ' +
        'nothing indexes a recorded file path against one, so `--touching` cannot be answered ' +
        'here. Use `orcaops list --touching <glob>` to find the artifacts that changed the path, ' +
        'then `orcaops knowledge lookup --identity <kind>:<id>` or `--subject <subject id>`.',
      'touching'
    );
  const identities = (opts.identity ?? []).map(identityOf);
  const named = [
    opts.adopted === true ? 'adopted' : null,
    identities.length > 0 ? 'identity' : null,
    opts.subject === undefined ? null : 'subject',
    opts.text === undefined || opts.text.trim().length === 0 ? null : 'text',
  ].filter((value) => value !== null);
  if (named.length !== 1)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Ask about one thing: `--adopted`, some text, one `--subject <subject id>`, or one or more ' +
        '`--identity <kind>:<id>`',
      'text'
    );
  // The one question that finds rules without wording to match them against, which is what an
  // agent has before a plan exists: a rule the task never mentions is exactly the rule a text or
  // reference route would drop, and the one the work most needs not to miss.
  if (opts.adopted === true) return { kind: 'adopted' };
  if (identities.length > 0) return { kind: 'identities', targets: identities };
  if (opts.subject !== undefined) return { kind: 'subject', subjectId: opts.subject };
  return { kind: 'text', text: opts.text as string };
}

function scopeOf(value: string | undefined, projectId: string) {
  if (value === undefined || value === 'project')
    return { kind: 'project' as const, project_id: projectId };
  const artifactId = value.startsWith('artifact:') ? value.slice('artifact:'.length) : '';
  if (artifactId.length === 0)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      '--scope takes `project` or `artifact:<id>`',
      'scope'
    );
  return { kind: 'artifact' as const, artifact_id: artifactId };
}

/**
 * `orcaops knowledge lookup` — what continuing knowledge bears on some work, at a knowledge
 * boundary the answer always names. It asks nothing, writes nothing, upgrades nothing and starts
 * no worker: a lookup is a passive read, and a passive read that quietly began paid interpretation
 * would spend money nobody asked it to.
 */
export async function knowledgeLookupAction(opts: KnowledgeLookupOptions = {}): Promise<void> {
  try {
    const subject = subjectOf(opts);
    const limit =
      opts.limit === undefined
        ? DEFAULT_LIMIT
        : boundedNumber(opts.limit, { min: 1, max: MAX_LIMIT }, '--limit');
    const boundary = knowledgeBoundaryOption(opts.atBoundary);
    const answer = await readKnowledgeContext({
      subject,
      limit,
      boundary,
      scope: opts.scope,
      software: softwareOf(opts),
    });
    if (opts.json === true) {
      emitOk({ ...answer });
      return;
    }
    writeTerminalSafeStdout(formatKnowledgeContext(answer));
  } catch (err) {
    if (opts.json === true) emitError(err);
    writeErrorLine(err);
    throw new CliExit(1);
  }
}

export type KnowledgeLookupAnswer = KnowledgeContextAnswer & {
  task_selection:
    | { kind: 'absent' }
    | { kind: 'ambiguous'; artifact_ids: readonly string[] }
    | { kind: 'selected'; artifact_id: string; plan_event_id: string };
  applicable_not_selected: ApplicableNotSelected;
  /** The items open about the identities in view. Null when this read composed none. */
  reconsideration: KnowledgeReconsiderationSummary | null;
  /** Who may already decide what about the identities in view. Null when this read composed none. */
  assignments: KnowledgeAssignmentSummary | null;
};

async function readKnowledgeContext(input: {
  subject: KnowledgeContextSubject;
  limit: number;
  boundary: number | 'now';
  scope: string | undefined;
  software: SelectedImplementation | null;
}): Promise<KnowledgeLookupAnswer> {
  const context = await resolveDatabaseHistoryCommandContext({
    profile: 'status',
    selector: { scope: 'project' },
  });
  let composed;
  let plan: ActivePlanSelection | null;
  let taskSelection: ActiveTaskSelection;
  try {
    const project = context.scope.projects[0];
    const authority = project?.authority ?? null;
    if (!project?.database || authority === null)
      throw new OrcaopsError(
        ErrorCodes.UNINITIALIZED,
        project?.completeness.issues[0]?.message ??
          'This repository has no orcaops project history to look knowledge up in yet.'
      );
    const read = project.database.read((view) => {
      const scope = scopeOf(input.scope, authority.projectId);
      const knowledge = projectKnowledgeContext(view, {
        projectId: authority.projectId,
        scope,
        // The caller's boundary, never one defaulted here: an answer that picked its own would
        // answer a question nobody asked. `now` is the caller asking for the committed sequence.
        boundary: input.boundary,
        mode: input.boundary === 'now' ? 'current' : 'historical',
        subject: input.subject,
        // The same software the assessments are judged against, so one question decides both what
        // applies and which evidence answers it.
        ...(input.software === null ? {} : { implementation: input.software }),
        assessments: true,
        reconsideration: true,
        // Who may already decide what about these identities, and for whom a conflict here needs no
        // new instruction. The acting party is this invocation's account, asserted and never
        // authenticated, because an assignment covers a rule for whoever it made responsible.
        assignments: true,
        acting: { kind: 'actor', actor: invokingActor() },
        // What retrieval READS. What the answer carries is bounded below, where placement is known.
        bounds: {
          maxIdentities: input.limit,
          maxStatementBytes: MAX_STATEMENT_BYTES,
          maxSearchTerms: RELATED_KNOWLEDGE_SEARCH_TERMS,
          maxSearchHits: RELATED_KNOWLEDGE_SEARCH_HITS,
          maxSourcesFollowed: RELATED_KNOWLEDGE_SOURCES_FOLLOWED,
        },
      });
      const at = knowledge.request.knowledge_boundary;
      if (scope.kind === 'artifact') {
        const planEventId = latestVisiblePlanEventId(view, scope.artifact_id, at);
        return {
          knowledge,
          plan: planEventId === null ? null : { artifactId: scope.artifact_id, planEventId },
          taskSelection:
            planEventId === null
              ? ({ kind: 'absent' } as const)
              : ({
                  kind: 'selected',
                  artifactId: scope.artifact_id,
                  planEventId,
                } as const),
        };
      }
      const branch = context.scope.gitContext?.branch ?? null;
      const active =
        branch === null
          ? { kind: 'absent' as const }
          : activeTaskSelectionAtBoundary(view, branch, at);
      return {
        knowledge,
        taskSelection: active,
        plan:
          active.kind === 'selected'
            ? { artifactId: active.artifactId, planEventId: active.planEventId }
            : null,
      };
    }).value;
    composed = read.knowledge;
    plan = read.plan;
    taskSelection = read.taskSelection;
  } finally {
    context.scope.close();
  }

  const surface = await readProcessingSurface();
  const history = await readProcessingHistory();
  const configuration =
    surface.resolution.status === 'ready' ? surface.resolution.configuration : null;
  const consent =
    configuration === null
      ? null
      : reportProcessingConsent({
          repoRoot: surface.repository.repoRoot,
          projectId: surface.projectId,
          configuration,
          backlog: history.backlog,
        });
  const answer = knowledgeContextAnswer(
    composed,
    processingCoverageOf({
      enabled: surface.enabled,
      source: surface.source,
      resolution: surface.resolution,
      history,
      consent: consent?.decision ?? null,
      boundary: composed.request.knowledge_boundary,
    }),
    // `--limit` bounds what the ANSWER carries, so it is spent after every identity has been
    // placed: an adopted rule that applies here is never dropped while a background one remains.
    { maxEntries: input.limit, maxStatementBytes: MAX_STATEMENT_BYTES },
    { software: input.software }
  );
  // The diff is put beside the answer rather than folded into it: the answer says what applies,
  // and this says which of it the plan in view has not recorded a use of, so a known rule cannot
  // disappear because the agent never selected it. It asks nothing and writes nothing.
  const applicable = applicableNotSelected(answer, plan);
  const notSelected =
    taskSelection.kind === 'ambiguous'
      ? {
          ...applicable,
          statement:
            `Active task selection is ambiguous between ${taskSelection.artifactIds.join(', ')}; ` +
            `no task or plan was guessed. ${applicable.statement}`,
        }
      : applicable;
  return {
    ...answer,
    task_selection:
      taskSelection.kind === 'selected'
        ? {
            kind: taskSelection.kind,
            artifact_id: taskSelection.artifactId,
            plan_event_id: taskSelection.planEventId,
          }
        : taskSelection.kind === 'ambiguous'
          ? { kind: taskSelection.kind, artifact_ids: taskSelection.artifactIds }
          : taskSelection,
    applicable_not_selected: notSelected,
    // Beside the answer for the same reason, and read in the composer's own snapshot: what
    // somebody has already noticed may be worth another look, never a defect and never a finding.
    // The human renderer may ignore it.
    reconsideration: knowledgeReconsiderationSummary(composed),
    assignments: knowledgeAssignmentSummary(composed),
  };
}
