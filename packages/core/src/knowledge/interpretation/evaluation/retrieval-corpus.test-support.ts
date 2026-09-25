// The fixed evaluation set placed in a real project database, so bounded retrieval can be measured
// against it rather than against a hand-built answer.
//
// Every record the set expects a case to be related to is published from an artifact of its own,
// through the public writers, as the candidate an earlier task left behind; every case's source is
// captured into an artifact of its own, holding nothing but that source. So no case reaches a
// record through its own artifact, and what retrieval finds it finds the way a later task would:
// through the search over structured captures. Nothing here calls a model.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type AuthorityScope,
  type CapturePlanInput,
  CapturePlanInputSchema,
  uuidv7,
} from '@orcaops/storage';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  appendProjectPlanCapture,
  createProjectRequirement,
  initializeProjectDatabase,
  preparePlanCaptureCommand,
  preparePlanCaptureInput,
  type ProjectDatabase,
  projectDatabasePath,
  publishProjectContinuingClaimRevision,
  publishProjectContinuingDecisionRevision,
  publishProjectKnowledgeSource,
  publishProjectSelection,
} from '@orcaops/storage/history/database';
import { digest, recordChecksum } from '@orcaops/storage/history/primitives';

import type { InterpretationManifest, ManifestRevisionEntry } from '../manifest.js';
import type { EvaluationCase } from './harness.js';

const AT = '2026-04-01T09:00:00.000Z';
const OWNER = { identity: 'owner@example.test', basis: 'agent_reported_user_instruction' } as const;
const AGENT = { identity: 'claude-code', basis: 'source_attributed' } as const;
const BY_OWNER = { kind: 'actor', actor: OWNER } as const;

/** A plan label is one trimmed line of at most seventy characters. */
const headline = (text: string) => text.slice(0, 70).trim();

/** Where a record's statement stands in the artifact that established it. */
const CRITERION_FIELD = 'plan_steps[0].acceptance_criteria[0].text';

export interface CorpusCase {
  readonly name: string;
  readonly manifest: InterpretationManifest;
  readonly sourceText: string;
  readonly artifactId: string;
  readonly eventId: string;
  readonly source_scope?: AuthorityScope;
  /** Every identity the case's manifest says this source is related to. */
  readonly expected: readonly string[];
}

export interface RetrievalCorpus {
  readonly handle: ProjectDatabase;
  readonly projectId: string;
  readonly cases: readonly CorpusCase[];
  /** The write sequence every case is retrieved at: every record above is committed. */
  readonly boundary: number;
  close(): Promise<void>;
}

/** A single-step plan whose one acceptance criterion holds `text`, captured into its own artifact. */
export async function captureSource(
  handle: ProjectDatabase,
  input: { artifactId: string; eventId: string; label: string; text: string }
): Promise<void> {
  const authored: CapturePlanInput = CapturePlanInputSchema.parse({
    idempotency_key: `retrieval:${input.eventId}`,
    task: input.text,
    label: headline(input.label),
    plan_steps: [
      {
        text: headline(input.label),
        label: headline(input.label),
        acceptance_criteria: [{ text: input.text }],
      },
    ],
  });
  const prepared = preparePlanCaptureInput({ authored, sourcePlan: null }, []);
  const operationId = uuidv7();
  const record = {
    event_id: input.eventId,
    type: 'plan_captured' as const,
    ts: AT,
    schema_version: 1,
    idempotency_key: authored.idempotency_key,
    payload: {
      schema_version: 4,
      artifact_id: input.artifactId,
      branch: 'main',
      base_sha: 'a'.repeat(40),
      agent: 'codex',
      agent_session_id: null,
      task: authored.task,
      label: authored.label,
      plan_steps: authored.plan_steps.map((step) => ({
        ...step,
        step_id: uuidv7(),
        acceptance_criteria: step.acceptance_criteria.map((criterion) => ({
          ...criterion,
          criterion_id: uuidv7(),
        })),
      })),
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: AT,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      prior_plan_event_id: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    },
  };
  await appendProjectPlanCapture(handle, {
    capture: {
      artifactId: input.artifactId,
      operationId,
      expectedRevision: null,
      eventBytes: Buffer.from(
        `${JSON.stringify({ ...record, checksum: recordChecksum(record) })}\n`
      ),
      sidecarPayloads: [],
      secretAllow: [],
      execution: {
        kind: 'create',
        ts: AT,
        context: {
          repository_instance_id: handle.authority.repositoryInstanceId,
          worktree_id: uuidv7(),
          git_context: { branch: 'main', head_sha: 'a'.repeat(40) },
        },
      },
    },
    command: preparePlanCaptureCommand(prepared, {
      artifactId: input.artifactId,
      planEventId: input.eventId,
      originalOperationId: operationId,
      admissionOperationId: operationId,
    }),
  });
}

async function captureFieldSource(
  handle: ProjectDatabase,
  artifactId: string,
  eventId: string
): Promise<string> {
  const published = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: {
      source_id: uuidv7(),
      occurrence: {
        kind: 'capture_field',
        artifact_id: artifactId,
        event_id: eventId,
        field_path: CRITERION_FIELD,
        position: 0,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: AGENT,
    secretAllow: [],
  });
  return published.value.sourceId;
}

async function instructionSource(handle: ProjectDatabase): Promise<string> {
  const bytes = Buffer.from('Adopt the records this project already agreed on.');
  const published = await publishProjectKnowledgeSource(handle, {
    operationId: uuidv7(),
    source: {
      source_id: uuidv7(),
      occurrence: {
        kind: 'user_instruction',
        retention: { kind: 'bytes', content_sha256: digest(bytes) },
        location: 'session transcript, turn 1',
        source_time: AT,
      },
      source_author: OWNER,
      interpreted_by: null,
      access_restriction: null,
    },
    recordedBy: AGENT,
    retainedBytes: bytes,
    secretAllow: [],
  });
  return published.value.sourceId;
}

const passageOf = (sourceId: string, statement: string) => ({
  source_id: sourceId,
  location: `bytes:0-${Buffer.byteLength(statement, 'utf8')}`,
  passage_sha256: digest(Buffer.from(statement, 'utf8')),
});

const revisionCommon = (sourceId: string, statement: string) => ({
  applicability: { all_of: [] },
  source_ids: [sourceId],
  passages: [passageOf(sourceId, statement)],
  source_standing: 'explicit_instruction' as const,
  recorded_at: AT,
});

async function publishRecord(
  handle: ProjectDatabase,
  entry: ManifestRevisionEntry,
  sourceId: string
): Promise<void> {
  const { revision, statement } = entry;
  const common = revisionCommon(sourceId, statement);
  const occurrence = { source_id: sourceId, location: passageOf(sourceId, statement).location };
  if (revision.kind === 'requirement') {
    await createProjectRequirement(handle, {
      operationId: uuidv7(),
      identity: {
        requirement_id: revision.entity_id,
        origin: {
          kind: 'promoted_source',
          passage: passageOf(sourceId, statement),
          promoted_at: AT,
        },
      },
      revision: {
        ...common,
        requirement_id: revision.entity_id,
        revision_id: revision.revision_id,
        previous_revision_id: null,
        statement,
        rationale: null,
        subject: null,
        duration: { kind: 'continuing' },
      },
      attributedTo: BY_OWNER,
      secretAllow: [],
    });
    return;
  }
  if (revision.kind === 'decision') {
    await publishProjectContinuingDecisionRevision(handle, {
      operationId: uuidv7(),
      revision: {
        ...common,
        decision_id: revision.entity_id,
        revision_id: revision.revision_id,
        previous_revision_id: null,
        chosen_approach: statement,
        rationale: 'The project recorded this approach with the task that chose it.',
        alternatives: [],
        assumptions: [],
        reconsideration_conditions: [],
        subject: null,
        derivation: null,
      },
      attributedTo: BY_OWNER,
      occurrence,
      secretAllow: [],
    });
    return;
  }
  await publishProjectContinuingClaimRevision(handle, {
    operationId: uuidv7(),
    revision: {
      ...common,
      claim_id: revision.entity_id,
      revision_id: revision.revision_id,
      previous_revision_id: null,
      statement,
      subject: null,
      observation_ids: [],
      verification: null,
    },
    attributedTo: BY_OWNER,
    occurrence,
    secretAllow: [],
  });
}

/**
 * The records of the set, each named by the identity it belongs to. A case may name the same
 * identity as an earlier case does; the store holds one record for it, published once.
 */
function relatedRecords(cases: readonly EvaluationCase[]): Map<string, ManifestRevisionEntry> {
  const records = new Map<string, ManifestRevisionEntry>();
  for (const evaluated of cases)
    for (const entry of evaluated.manifest.revisions)
      if (!records.has(entry.revision.entity_id)) records.set(entry.revision.entity_id, entry);
  return records;
}

const relatedIdentities = (manifest: InterpretationManifest): string[] => [
  ...new Set(manifest.related_knowledge.map((entry) => entry.resolved.target.entity_id)),
];

/**
 * Every record the set names as related knowledge, established in a project database through the
 * public writers: one artifact per identity, the record promoted from a source published at its
 * captured criterion, and an accepted selection with the designation the set gives it. A withdrawn
 * or superseded revision is published and never selected.
 *
 * Taken as a handle rather than opening one, so the same corpus can be placed in a database that
 * already holds something else — a worker's, for instance, whose jobs are then judged against the
 * knowledge these calls established.
 */
export async function placeRelatedRecords(
  handle: ProjectDatabase,
  input: { projectId: string; cases: readonly EvaluationCase[] }
): Promise<void> {
  const instructionId = await instructionSource(handle);
  for (const [entityId, entry] of relatedRecords(input.cases)) {
    const artifactId = uuidv7();
    const eventId = uuidv7();
    await captureSource(handle, {
      artifactId,
      eventId,
      label: `Establish ${entityId}`,
      text: entry.statement,
    });
    const sourceId = await captureFieldSource(handle, artifactId, eventId);
    await publishRecord(handle, entry, sourceId);
    if (entry.designation === null) continue;
    await publishProjectSelection(handle, {
      operationId: uuidv7(),
      selection: {
        selection_id: uuidv7(),
        kind: 'accepted',
        target: entry.revision,
        scope: { kind: 'project', project_id: input.projectId },
        designation: entry.designation,
        authorization: {
          kind: 'explicit_instruction',
          instruction_source_id: instructionId,
          scope: { kind: 'project', project_id: input.projectId },
        },
        expected_state: { kind: 'initial' },
      },
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    });
  }
}

export async function retrievalCorpus(cases: readonly EvaluationCase[]): Promise<RetrievalCorpus> {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'orcaops-retrieval-recall-')),
  });
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: AT,
    authorize() {},
  });
  const close = async () => {
    handle.close();
    await rm(root.resolvedRoot, { recursive: true, force: true });
  };

  try {
    await placeRelatedRecords(handle, { projectId: authority.projectId, cases });

    const corpus: CorpusCase[] = [];
    for (const evaluated of cases) {
      const artifactId = uuidv7();
      const eventId = uuidv7();
      await captureSource(handle, {
        artifactId,
        eventId,
        label: evaluated.name,
        text: evaluated.source_text,
      });
      corpus.push({
        name: evaluated.name,
        manifest: evaluated.manifest,
        sourceText: evaluated.source_text,
        artifactId,
        eventId,
        ...(evaluated.source_scope === undefined ? {} : { source_scope: evaluated.source_scope }),
        expected: relatedIdentities(evaluated.manifest),
      });
    }
    return {
      handle,
      projectId: authority.projectId,
      cases: corpus,
      boundary: handle.read(() => null).counters.writeSequence,
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
