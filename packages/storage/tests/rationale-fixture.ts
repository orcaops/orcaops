import {
  acceptedSelection,
  AT,
  instructedBy,
  instructionSource,
  requirementRevision,
} from './knowledge-authority-store.js';
import {
  BY_OWNER,
  captureCheckpoint,
  type CapturedPlan,
  capturePlan,
  DETECTOR,
  knowledgeStore,
  OWNER,
} from './knowledge-store.js';
import { canonicalJson } from '../src/events/canonical-json.js';
import { readProjectArtifact } from '../src/history/database/artifacts.js';
import type { ProjectDatabase } from '../src/history/database/connection.js';
import { appendProjectExecutionCapture } from '../src/history/database/execution-capture.js';
import { readProjectExecution } from '../src/history/database/execution-records.js';
import { publishProjectContinuingDecisionRevision } from '../src/history/database/knowledge-decisions.js';
import { publishInterpretedKnowledge } from '../src/history/database/knowledge-interpretation.js';
import { createProjectRequirement } from '../src/history/database/knowledge-requirements.js';
import { publishProjectSelection } from '../src/history/database/knowledge-selections.js';
import { digest, recordChecksum } from '../src/history/event-integrity.js';
import { uuidv7 } from '../src/ids/uuidv7.js';
import type { CheckpointDecision } from '../src/schema/checkpoint.js';
import {
  buildDefaultSkippedFingerprintSummary,
  buildDefaultSkippedSnapshotBoundary,
} from '../src/schema/diff-fingerprint.js';
import {
  type KnowledgeInterpretation,
  knowledgeInterpretationId,
} from '../src/schema/knowledge-contract.js';
import { interpretationSegmentId } from '../src/schema/knowledge-processing-contract.js';
import { prepareInterpretationText } from '../src/text/interpretation-preparation.js';

export const WORDS = {
  history:
    'Keep navigator-owned history because native Back must restore the original list and scroll position.',
  tabs: 'Keep independent real tab stacks because switching destinations must preserve each tab history.',
  band: 'Keep the cross-area return band beneath the header because the originating area needs a visible return control.',
  removal:
    'Remove the cross-area return band because dock switching now supplies the area control; retain independent real tab stacks.',
  raw: 'Wait for modal dismissal completion before moving to a destination because an invisible modal can intercept taps.',
  paraphrase: 'Eliminate the horizontal ribbon; the bottom capsule now supplies that affordance.',
  correction:
    'The reported device test ran against the prior build; the current navigation build has not been verified.',
};

export interface Capture {
  plan: CapturedPlan;
  worktreeId: string;
  eventId: string;
  fields: Array<{ path: string; text: string }>;
}

export async function planCapture(
  handle: ProjectDatabase,
  label: string,
  texts: string[]
): Promise<Capture> {
  const plan: CapturedPlan = {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    task: label,
    steps: [{ stepId: uuidv7(), criteria: texts.map((text) => ({ criterionId: uuidv7(), text })) }],
  };
  const { worktreeId } = await capturePlan(handle, plan);
  return {
    plan,
    worktreeId,
    eventId: plan.planEventId,
    fields: texts.map((text, i) => ({
      path: `plan_steps[0].acceptance_criteria[${i}].text`,
      text,
    })),
  };
}

export async function closeCapture(
  handle: ProjectDatabase,
  capture: Capture,
  texts: Array<string | CheckpointDecision>,
  files: string[]
): Promise<Capture> {
  await captureCheckpoint(handle, capture.plan, capture.worktreeId);
  const artifact = readProjectArtifact(handle, capture.plan.artifactId)!;
  const owner = readProjectExecution(handle, capture.plan.artifactId)!;
  const record = {
    event_id: uuidv7(),
    type: 'checkpoint_closed' as const,
    ts: AT,
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload: {
      artifact_id: capture.plan.artifactId,
      n: 1,
      head_sha: 'b'.repeat(40),
      summary: 'Implemented the recorded choices.',
      files_changed: files,
      completed_step_ids: [],
      decisions: texts.map((decision) =>
        typeof decision === 'string'
          ? {
              decision,
              reason: 'Retain the behavior described in the decision.',
            }
          : decision
      ),
      uncertainty: [],
      done_criteria: [],
      verification: [],
      ts: AT,
      closed_by_agent: 'codex',
      close_snapshot: buildDefaultSkippedSnapshotBoundary(),
      diff_fingerprint_summary: buildDefaultSkippedFingerprintSummary(),
    },
  };
  await appendProjectExecutionCapture(handle, {
    artifactId: capture.plan.artifactId,
    operationId: uuidv7(),
    expectedRevision: artifact.revision,
    eventBytes: Buffer.from(`${JSON.stringify({ ...record, checksum: recordChecksum(record) })}\n`),
    sidecarPayloads: [],
    secretAllow: [],
    execution: {
      kind: 'task',
      context: {
        repository_instance_id: handle.authority.repositoryInstanceId,
        worktree_id: capture.worktreeId,
        git_context: { branch: 'main', head_sha: 'b'.repeat(40) },
      },
      expectedVersion: owner.version,
      expectedGeneration: owner.state.binding_generation,
      explicitTarget: true,
    },
  });
  return {
    ...capture,
    eventId: record.event_id,
    fields: texts.map((text, i) => ({
      path: `decisions[${i}].decision`,
      text: typeof text === 'string' ? text : text.decision,
    })),
  };
}

export async function interpret(
  handle: ProjectDatabase,
  capture: Capture,
  index: number,
  restricted = false,
  reason?: string
) {
  const field = capture.fields[index]!;
  const sourceFields = [
    field,
    ...(reason === undefined
      ? []
      : [{ path: field.path.replace(/\.decision$/, '.reason'), text: reason }]),
  ];
  const material = sourceFields.map((sourceField) => {
    const prepared = prepareInterpretationText(sourceField.text);
    const sourceId = `${capture.eventId}#${sourceField.path}#0`;
    const occurrence = {
      kind: 'capture_field' as const,
      artifact_id: capture.plan.artifactId,
      event_id: capture.eventId,
      field_path: sourceField.path,
      position: 0,
    };
    const segmentIdentity = {
      source_id: sourceId,
      occurrence,
      role: 'decision' as const,
      purpose: 'primary' as const,
      original_sha256: prepared.originalSha256,
      prepared_sha256: prepared.preparedSha256,
      mapping_version: prepared.mappingVersion,
      mapping_sha256: prepared.mappingSha256,
      prepared_range: { start: 0, end: Buffer.byteLength(prepared.prepared) },
      mapping: [...prepared.mapping],
    };
    const segment = { segment_id: interpretationSegmentId(segmentIdentity), ...segmentIdentity };
    return { sourceId, occurrence, segment, prepared, text: sourceField.text };
  });
  const sourceId = material[0]!.sourceId;
  const identity: Omit<KnowledgeInterpretation, 'interpretation_id' | 'recorded_at'> = {
    source_origin: {
      source_id: sourceId,
      task: { artifact_id: capture.plan.artifactId, plan_event_id: capture.plan.planEventId },
    },
    wording: field.text,
    source_form: 'stated_decision',
    proposed_record: 'decision',
    intended_scope: { kind: 'project' },
    rationale:
      reason === undefined
        ? { kind: 'unknown' }
        : { kind: 'stated', wording: reason, evidence_positions: [1] },
    uncertainties: [],
    canonical_outcome: { kind: 'none', target: null },
    attributed_to: DETECTOR,
    evidence: material.map(({ sourceId, segment, prepared, text }) => ({
      source_id: sourceId,
      segment_id: segment.segment_id,
      mapping_version: prepared.mappingVersion,
      mapping_sha256: prepared.mappingSha256,
      prepared_sha256: prepared.preparedSha256,
      prepared_start_utf8: 0,
      prepared_end_utf8: Buffer.byteLength(text),
      original_ranges: [{ start: 0, end: Buffer.byteLength(text) }],
      quote: text,
      passage_sha256: digest(Buffer.from(text)),
    })),
  };
  identity.evidence.sort((left, right) => {
    const a = canonicalJson(left);
    const b = canonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (identity.rationale.kind === 'stated')
    identity.rationale.evidence_positions = [
      identity.evidence.findIndex((entry) => entry.source_id === material[1]!.sourceId),
    ];
  const record = {
    ...identity,
    interpretation_id: knowledgeInterpretationId('knowledge-interpretation@2', identity),
    recorded_at: AT,
  };
  const { attributed_to: _attribution, ...authored } = record;
  await publishInterpretedKnowledge(handle, {
    operationId: uuidv7(),
    sources: material.map(({ sourceId, occurrence }) => ({
      source_id: sourceId,
      occurrence,
      source_author: OWNER,
      interpreted_by: DETECTOR,
      access_restriction: restricted ? 'private' : null,
    })),
    segments: material.map((item) => item.segment),
    processorContract: 'knowledge-interpretation@2',
    recordedBy: OWNER,
    attributedTo: DETECTOR,
    scope: { kind: 'artifact', artifact_id: capture.plan.artifactId },
    records: [{ kind: 'interpretation', interpretation: authored, restsOn: [] }],
    secretAllow: [],
  });
  return record;
}

export async function adoptRule(handle: ProjectDatabase, text: string) {
  const instructionId = await instructionSource(handle, text);
  const id = uuidv7();
  const passage = {
    source_id: instructionId,
    location: 'instruction',
    passage_sha256: digest(Buffer.from(text)),
  };
  const revision = requirementRevision(id, instructionId, { statement: text, passages: [passage] });
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: { requirement_id: id, origin: { kind: 'promoted_source', passage, promoted_at: AT } },
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const scope = { kind: 'project' as const, project_id: handle.authority.projectId };
  const target = { kind: 'requirement' as const, entity_id: id, revision_id: revision.revision_id };
  await publishProjectSelection(handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(target, scope, instructedBy(instructionId, scope)),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  return target;
}

export async function navigationFixture(noise = 0) {
  const { handle, authority } = await knowledgeStore();
  const main = await planCapture(
    handle,
    'Maintain native navigation',
    Array.from(
      { length: Math.max(noise, 1) },
      (_, i) => `Pin auxiliary dependency package ${i} to its tested patch version.`
    )
  );
  for (let i = 0; i < noise; i++) await interpret(handle, main, i);
  const history = await closeCapture(
    handle,
    main,
    [WORDS.history, WORDS.tabs, WORDS.band, WORDS.raw],
    ['src/navigation.ts', 'src/tabs.ts']
  );
  const records = [];
  for (let i = 0; i < 3; i++) records.push(await interpret(handle, history, i));
  const other = await planCapture(handle, 'Revise area presentation', [WORDS.removal]);
  const unrelated = await planCapture(handle, 'Revise visual affordance', [WORDS.paraphrase]);
  const competingPlan = await planCapture(handle, 'Preserve tab state', [
    'Keep tab state persistent.',
  ]);
  const competing = await closeCapture(handle, competingPlan, [WORDS.tabs], ['src/navigation.ts']);
  await interpret(handle, competing, 0);
  const global = await adoptRule(
    handle,
    'Local history must remain readable without a network connection.'
  );
  return { handle, authority, main, history, records, other, unrelated, competing, global };
}

export async function decision(
  handle: ProjectDatabase,
  sourceId: string,
  wording: string,
  path = 'instruction'
) {
  const target = { kind: 'decision' as const, entity_id: uuidv7(), revision_id: uuidv7() };
  await publishProjectContinuingDecisionRevision(handle, {
    operationId: uuidv7(),
    attributedTo: BY_OWNER,
    occurrence: { source_id: sourceId, location: path },
    secretAllow: [],
    revision: {
      decision_id: target.entity_id,
      revision_id: target.revision_id,
      previous_revision_id: null,
      chosen_approach: wording,
      rationale: 'Preserve native navigation semantics.',
      alternatives: [],
      assumptions: [],
      reconsideration_conditions: [],
      subject: null,
      derivation: null,
      applicability: { all_of: [] },
      source_ids: [sourceId],
      passages: [
        { source_id: sourceId, location: path, passage_sha256: digest(Buffer.from(wording)) },
      ],
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
  });
  return target;
}
