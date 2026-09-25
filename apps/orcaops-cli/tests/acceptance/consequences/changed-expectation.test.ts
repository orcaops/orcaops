// A changed expectation identifies relevant downstream work with reasons.
//
// Plan §11 G. One temporary project database holds a rule the project adopted, two plans that
// recorded a use of it, an assessment that concluded about it, a requirement that depends on it and
// a decision derived from it; the rule is then replaced under an informed instruction. What the
// scenario reads is `orcaops knowledge consequences`, run as a person runs it.
//
// Nothing here is a finding that any of the work reached is wrong, and nothing claims the answer is
// complete: what the answer could not map is carried as a limit beside it.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  publishProjectContinuingDecisionRevision,
  publishProjectRelationship,
} from '@orcaops/storage/history/database';

import type { KnowledgeConsequencesReport } from '../../../src/commands/knowledge/consequences.js';
import {
  type ConsequenceProject,
  consequenceProject,
  orcaops,
  orcaopsWithDocument,
} from '../../helpers/consequences-acceptance.js';
import {
  adoptedRequirement,
  AT,
  instructionSource,
  OWNER,
  planEventOf,
  recordedRequirement,
  replaceRequirement,
} from '../../helpers/knowledge-records.js';

const OFFLINE = 'Local capture works with no Cloud connection.';
const REVISED = 'Local capture works with no Cloud connection, and says so in the summary.';
const QUEUE = 'Unsent captures wait in a local queue.';
const BY_OWNER = { kind: 'actor', actor: OWNER } as const;

const reportOf = (payload: Record<string, unknown>) =>
  payload as unknown as KnowledgeConsequencesReport;

const keysOf = (report: KnowledgeConsequencesReport) =>
  report.answers[0]!.affected.map((entry) => entry.key);

const limitKinds = (report: KnowledgeConsequencesReport) =>
  report.answers[0]!.limits.map((limit) => limit.kind);

const entryFor = (report: KnowledgeConsequencesReport, key: string) =>
  report.answers[0]!.affected.find((entry) => entry.key === key);

async function planUsing(
  project: ConsequenceProject,
  rule: { requirementId: string; revisionId: string },
  role: string
) {
  const artifactId = await project.capture();
  const planEventId = planEventOf(project.writer, artifactId);
  const recorded = await orcaops(project, [
    'task',
    'uses',
    'record',
    '--artifact',
    artifactId,
    '--plan-event',
    planEventId,
    '--identity',
    `requirement:${rule.requirementId}`,
    '--revision',
    rule.revisionId,
    '--role',
    role,
    '--discovered-at',
    AT,
    '--discovered-by',
    'owner',
    '--json',
  ]);
  expect(recorded.exitCode, recorded.stdout + recorded.stderr).toBe(0);
  return { artifactId, planEventId };
}

async function decisionDerivedFrom(
  project: ConsequenceProject,
  rule: { requirementId: string; revisionId: string; instructionId: string }
) {
  const sourceId = await instructionSource(
    project.writer,
    'We queue unsent captures on disk rather than holding them in memory.'
  );
  const decisionId = uuidv7();
  const revisionId = uuidv7();
  const passage = { source_id: sourceId, location: 'bytes:0-64', passage_sha256: 'a'.repeat(64) };
  await publishProjectContinuingDecisionRevision(project.writer, {
    operationId: uuidv7(),
    revision: {
      decision_id: decisionId,
      revision_id: revisionId,
      previous_revision_id: null,
      chosen_approach: 'Queue unsent captures on disk.',
      rationale: 'Memory does not survive the process the capture was made in.',
      alternatives: [],
      assumptions: ['Captures are made while the network is down.'],
      reconsideration_conditions: [],
      applicability: { all_of: [] },
      subject: null,
      derivation: {
        derived_from: {
          kind: 'requirement',
          entity_id: rule.requirementId,
          revision_id: rule.revisionId,
        },
        explanation: 'The queue exists to keep the offline promise.',
        source_id: rule.instructionId,
        derived_at: AT,
      },
      source_ids: [sourceId],
      passages: [passage],
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
    attributedTo: BY_OWNER,
    occurrence: { source_id: sourceId, location: passage.location },
    secretAllow: [],
  });
  const relationshipId = uuidv7();
  await publishProjectRelationship(project.writer, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: relationshipId,
      relation: 'motivates',
      from: {
        kind: 'requirement',
        entity_id: rule.requirementId,
        revision_id: rule.revisionId,
      },
      to: { kind: 'decision', entity_id: decisionId, revision_id: revisionId },
      scope: { kind: 'project', project_id: project.authority.projectId },
      standing: 'suggested',
      authorization: null,
      source_ids: [sourceId],
      explanation: 'The offline promise looks like the reason for the queue.',
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  return { decisionId, revisionId, relationshipId };
}

async function dependentOn(
  project: ConsequenceProject,
  rule: { requirementId: string; revisionId: string; sourceId: string }
) {
  const dependent = await recordedRequirement(project.writer, { statement: QUEUE });
  const relationshipId = uuidv7();
  await publishProjectRelationship(project.writer, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: relationshipId,
      relation: 'depends_on',
      from: {
        kind: 'requirement',
        entity_id: dependent.requirementId,
        revision_id: dependent.revisionId,
      },
      to: { kind: 'requirement', entity_id: rule.requirementId, revision_id: rule.revisionId },
      scope: { kind: 'project', project_id: project.authority.projectId },
      standing: 'established',
      authorization: null,
      source_ids: [rule.sourceId],
      explanation: 'The queue exists because capture must work offline.',
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  return { ...dependent, relationshipId };
}

async function history(project: ConsequenceProject) {
  const projectId = project.authority.projectId;
  const adopted = await adoptedRequirement(project.writer, { projectId, statement: OFFLINE });
  const implementing = await planUsing(project, adopted, 'implement');
  const preserving = await planUsing(project, adopted, 'preserve');
  const dependent = await dependentOn(project, adopted);
  const decision = await decisionDerivedFrom(project, adopted);
  const assessmentId = randomUUID();
  const assessed = await orcaopsWithDocument(project, ['knowledge', 'assess', '--json'], {
    assessment_id: assessmentId,
    assessed_by: OWNER,
    expectations: [
      { kind: 'requirement', entity_id: adopted.requirementId, revision_id: adopted.revisionId },
    ],
    exception_ids: [],
    implementation: { kind: 'none_selected' },
    evidence: [],
    method: { name: 'reading the queue', configuration_sha256: null },
    conclusions: [
      {
        expectation: {
          kind: 'requirement',
          entity_id: adopted.requirementId,
          revision_id: adopted.revisionId,
        },
        conclusion: 'unresolved',
        reason: 'Nothing here identifies which build was running.',
      },
    ],
    check_states: [],
    coverage_limits: ['no build was identified'],
  });
  expect(assessed.exitCode, assessed.stdout + assessed.stderr).toBe(0);
  const successor = await replaceRequirement(project.writer, {
    projectId,
    adopted,
    statement: REVISED,
  });
  return { adopted, implementing, preserving, dependent, decision, assessmentId, successor };
}

const consequencesOf = (project: ConsequenceProject, requirementId: string, revisionId: string) =>
  orcaops(project, [
    'knowledge',
    'consequences',
    '--revision',
    `requirement:${requirementId}@${revisionId}`,
    '--json',
  ]);

describe('a changed expectation', { timeout: 300_000 }, () => {
  it('identifies relevant downstream work with reasons from domain-authored records', async () => {
    const project = await consequenceProject();
    const held = await history(project);

    const answer = await consequencesOf(
      project,
      held.adopted.requirementId,
      held.adopted.revisionId
    );

    expect(answer.exitCode, answer.stdout + answer.stderr).toBe(0);
    const report = reportOf(answer.payload);
    expect(report.answers).toHaveLength(1);
    expect(keysOf(report).sort()).toEqual(
      [
        `plan_event:${held.implementing.planEventId}`,
        `plan_event:${held.preserving.planEventId}`,
        `artifact:${held.implementing.artifactId}`,
        `artifact:${held.preserving.artifactId}`,
        `requirement:${held.dependent.requirementId}`,
        `decision:${held.decision.decisionId}`,
        `assessment:${held.assessmentId}`,
      ].sort()
    );
    const start = report.answers[0]!.start[0]!;
    expect(report.answers[0]!.change).toMatchObject({
      kind: 'revision',
      revision_id: held.adopted.revisionId,
    });
    expect(start).toMatchObject({ kind: 'identity', revision_id: held.adopted.revisionId });
    expect(held.successor.revisionId).not.toBe(held.adopted.revisionId);
    for (const entry of report.answers[0]!.affected) {
      expect(entry.reason, entry.key).not.toBe('');
      expect(entry.paths.length, entry.key).toBeGreaterThan(0);
      for (const path of entry.paths) {
        expect(path[0]!.from).toEqual(start);
        expect(path[path.length - 1]!.to).toEqual(entry.item);
        for (const [at, step] of path.entries())
          if (at > 0) expect(step.from).toEqual(path[at - 1]!.to);
        for (const step of path) expect(step.reason).not.toBe('');
      }
    }
    // The role each plan recorded is what the link says it is, not something inferred from the two.
    const roles = report.answers[0]!.affected.flatMap((entry) => entry.paths.flat())
      .filter((step) => step.relation === 'task_use')
      .map((step) => step.reason);
    expect(roles.some((reason) => reason.includes('implement'))).toBe(true);
    expect(roles.some((reason) => reason.includes('preserve'))).toBe(true);
  });

  it('marks a domain-authored explicit link apart from an inferred one', async () => {
    const project = await consequenceProject();
    const held = await history(project);

    const report = reportOf(
      (await consequencesOf(project, held.adopted.requirementId, held.adopted.revisionId)).payload
    );

    const dependent = entryFor(report, `requirement:${held.dependent.requirementId}`)!;
    expect(dependent.basis).toBe('explicit');
    expect(dependent.paths[0]![0]).toMatchObject({
      relation: 'depends_on',
      basis: 'explicit',
      standing: 'established',
      record_id: held.dependent.relationshipId,
    });
    const decision = entryFor(report, `decision:${held.decision.decisionId}`)!;
    expect(decision.basis).toBe('inferred');
    expect(decision.paths[0]![0]).toMatchObject({
      relation: 'motivates',
      basis: 'inferred',
      standing: 'suggested',
      record_id: held.decision.relationshipId,
    });
  });

  it('names missing coverage for domain-authored records rather than claiming complete impact coverage', async () => {
    const project = await consequenceProject();
    const held = await history(project);

    const report = reportOf(
      (await consequencesOf(project, held.adopted.requirementId, held.adopted.revisionId)).payload
    );

    // A recorded assumption is prose inside a decision revision with no column indexing its words,
    // so which decisions were read for a mention — and that the rest were not — is a limit rather
    // than a shorter list of affected items.
    expect(limitKinds(report)).toContain('assumptions_not_indexed');
    expect(
      report.answers[0]!.limits.find((limit) => limit.kind === 'assumptions_not_indexed')!.detail
    ).toContain('is not reported as having no assumption about this change');
    for (const limit of report.answers[0]!.limits) expect(limit.detail).not.toBe('');
    const coverage = report.answers[0]!.coverage;
    expect(coverage.statement).toContain('it is not complete impact coverage');
    expect(coverage.statement).toContain('a mapping this store cannot make are not here');
    expect(coverage.statement).toContain(
      'Reaching an item is not a finding that the item is wrong'
    );
    expect(report.coverage.processing).toMatchObject({
      enabled: false,
      claim: 'not_processed',
    });
  });

  it('gives the same answer when the same domain-authored change is asked about again', async () => {
    const project = await consequenceProject();
    const held = await history(project);

    const first = await consequencesOf(
      project,
      held.adopted.requirementId,
      held.adopted.revisionId
    );
    const second = await consequencesOf(
      project,
      held.adopted.requirementId,
      held.adopted.revisionId
    );

    expect(second.payload).toEqual(first.payload);
  });
});
