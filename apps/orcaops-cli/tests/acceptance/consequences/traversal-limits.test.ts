// Dependency traversal encounters cycles, many copies, or unknown mappings.
//
// Plan §12: the traversal terminates, deduplicates, explains limits, and does not imply complete
// impact coverage. One temporary project database holds a dependency that loops back on itself, one
// rule five retained sources restate word for word, five plans that used it and touched one file,
// and a path no artifact ever touched.
//
// Every claim here is about the answer `orcaops knowledge consequences` gives, never about what
// does or does not actually depend on anything.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  publishProjectPassageRestatement,
  publishProjectRelationship,
} from '@orcaops/storage/history/database';

import type { KnowledgeConsequencesReport } from '../../../src/commands/knowledge/consequences.js';
import {
  type ConsequenceProject,
  consequenceProject,
  orcaops,
  rowCounts,
} from '../../helpers/consequences-acceptance.js';
import {
  adoptedRequirement,
  AT,
  instructionSource,
  OWNER,
  planEventOf,
  recordedRequirement,
} from '../../helpers/knowledge-records.js';

const OFFLINE = 'Local capture works with no Cloud connection.';
const QUEUE = 'Unsent captures wait in a local queue.';
const TOUCHED = 'packages/sync/src/queue.ts';
const COPIES = 5;
const BY_OWNER = { kind: 'actor', actor: OWNER } as const;

const reportOf = (payload: Record<string, unknown>) =>
  payload as unknown as KnowledgeConsequencesReport;

const answerOf = (payload: Record<string, unknown>) => reportOf(payload).answers[0]!;

const limit = (payload: Record<string, unknown>, kind: string) =>
  answerOf(payload).limits.find((entry) => entry.kind === kind);

async function dependsOn(
  project: ConsequenceProject,
  from: { entity_id: string; revision_id: string },
  to: { entity_id: string; revision_id: string },
  explanation: string,
  sourceId: string
) {
  const relationshipId = uuidv7();
  await publishProjectRelationship(project.writer, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: relationshipId,
      relation: 'depends_on',
      from: { kind: 'requirement', ...from },
      to: { kind: 'requirement', ...to },
      scope: { kind: 'project', project_id: project.authority.projectId },
      standing: 'established',
      authorization: null,
      source_ids: [sourceId],
      explanation,
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  return relationshipId;
}

async function history(project: ConsequenceProject) {
  const projectId = project.authority.projectId;
  const rule = await adoptedRequirement(project.writer, { projectId, statement: OFFLINE });
  const partner = await recordedRequirement(project.writer, { statement: QUEUE });
  const ruleRef = { entity_id: rule.requirementId, revision_id: rule.revisionId };
  const partnerRef = { entity_id: partner.requirementId, revision_id: partner.revisionId };
  await dependsOn(
    project,
    partnerRef,
    ruleRef,
    'The queue exists because capture must work offline.',
    rule.sourceId
  );
  const closing = await dependsOn(
    project,
    ruleRef,
    partnerRef,
    'And the offline promise is only kept while the queue holds.',
    partner.sourceId
  );
  const plans: { artifactId: string; planEventId: string }[] = [];
  for (let copy = 0; copy < COPIES; copy += 1) {
    const artifactId = await project.capture();
    await project.recordFiles(artifactId, [TOUCHED]);
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
      'implement',
      '--discovered-at',
      AT,
      '--discovered-by',
      'owner',
      '--json',
    ]);
    expect(recorded.exitCode, recorded.stdout + recorded.stderr).toBe(0);
    plans.push({ artifactId, planEventId });
  }
  const restatements: string[] = [];
  for (let copy = 0; copy < COPIES; copy += 1) {
    const sourceId = await instructionSource(
      project.writer,
      `Handbook page ${copy + 1}. ${OFFLINE} That is the promise.`
    );
    const restatementId = uuidv7();
    await publishProjectPassageRestatement(project.writer, {
      operationId: uuidv7(),
      restatement: {
        restatement_id: restatementId,
        passage: {
          source_id: sourceId,
          location: `handbook:page-${copy + 1}`,
          passage_sha256: createHash('sha256').update(OFFLINE, 'utf8').digest('hex'),
        },
        restates: {
          kind: 'requirement',
          entity_id: rule.requirementId,
          revision_id: rule.revisionId,
        },
        recorded_at: AT,
      },
      attributedTo: BY_OWNER,
      secretAllow: [],
    });
    restatements.push(restatementId);
  }
  return { rule, partner, closing, plans, restatements };
}

const consequencesOf = (project: ConsequenceProject, requirementId: string) =>
  orcaops(project, [
    'knowledge',
    'consequences',
    '--identity',
    `requirement:${requirementId}`,
    '--json',
  ]);

describe('a traversal that meets cycles, copies and unknown mappings', { timeout: 300_000 }, () => {
  it('terminates on a domain-authored dependency that loops back, naming the link not followed', async () => {
    const project = await consequenceProject();
    const held = await history(project);

    const answer = await consequencesOf(project, held.rule.requirementId);

    expect(answer.exitCode, answer.stdout + answer.stderr).toBe(0);
    const cycle = limit(answer.payload, 'cycle');
    expect(cycle?.detail).toMatch(/^\d+ link\(s\) pointed back at an item already on the path/u);
    expect(cycle?.detail).toContain('rather than repeating those items');
    // The requirement on the other end of the loop is reached, once, and the walk stops there.
    expect(
      answerOf(answer.payload).affected.filter(
        (entry) => entry.key === `requirement:${held.partner.requirementId}`
      )
    ).toHaveLength(1);
    // No kept path walks one item twice, which is what makes the walk finite.
    for (const entry of answerOf(answer.payload).affected)
      for (const path of entry.paths) {
        const walked = [path[0]!.from, ...path.map((step) => step.to)].map((item) =>
          JSON.stringify(item)
        );
        expect(new Set(walked).size, entry.key).toBe(walked.length);
      }
  });

  it('deduplicates domain-authored copies into one item and names paths it did not keep', async () => {
    const project = await consequenceProject();
    const held = await history(project);

    const answer = await consequencesOf(project, held.rule.requirementId);

    expect(rowCounts(project.writer).passage_restatements).toBe(held.restatements.length);
    const keys = answerOf(answer.payload).affected.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining(held.plans.map((plan) => `artifact:${plan.artifactId}`))
    );
    // Five plans touched one file, so the file is one item reached five ways.
    const file = answerOf(answer.payload).affected.find(
      (entry) => entry.key === `code_path:${TOUCHED}`
    )!;
    expect(file.paths).toHaveLength(3);
    expect(file.paths_omitted).toBe(COPIES - 3);
    const paths = limit(answer.payload, 'path_count');
    expect(paths?.detail).toContain(`code_path:${TOUCHED}`);
    expect(paths?.detail).toContain('this answer keeps at most 3 per item');
  });

  it('explains a domain-backed unknown mapping as a limit, not as nothing depending on the code', async () => {
    const project = await consequenceProject();
    await history(project);

    const answer = await orcaops(project, [
      'knowledge',
      'consequences',
      '--touching',
      'packages/sync/src/nothing-touched-this.ts',
      '--json',
    ]);

    expect(answer.exitCode, answer.stdout + answer.stderr).toBe(0);
    expect(answerOf(answer.payload).affected).toEqual([]);
    expect(limit(answer.payload, 'no_code_association')?.detail).toContain(
      'not the same as nothing depending on it'
    );
  });

  it('refuses through the domain writer a relationship whose target is absent', async () => {
    const project = await consequenceProject();
    const held = await history(project);
    const before = rowCounts(project.writer);

    // Published through the domain writer, because no verb records a typed relationship.
    await expect(
      dependsOn(
        project,
        { entity_id: held.rule.requirementId, revision_id: held.rule.revisionId },
        { entity_id: uuidv7(), revision_id: uuidv7() },
        'A dependency on a requirement nobody here recorded.',
        held.rule.sourceId
      )
    ).rejects.toThrow('names a requirement revision this history does not hold');
    expect(rowCounts(project.writer)).toEqual(before);
  });

  it('does not imply complete impact coverage for domain-authored records', async () => {
    const project = await consequenceProject();
    const held = await history(project);

    const answer = await consequencesOf(project, held.rule.requirementId);

    const coverage = answerOf(answer.payload).coverage;
    expect(coverage.statement).toContain('it is not complete impact coverage');
    expect(coverage.statement).toContain('a dependency nobody recorded');
    expect(coverage.statement).toContain('a mapping this store cannot make are not here');
    expect(coverage.relations_followed).toContain('depends_on');
    expect(coverage.items_reached).toBe(answerOf(answer.payload).affected.length);
  });

  it('keeps every full path through a converging dependency graph', async () => {
    const project = await consequenceProject();
    const root = await adoptedRequirement(project.writer, {
      projectId: project.authority.projectId,
      statement: OFFLINE,
    });
    const left = await recordedRequirement(project.writer, { statement: 'Left depends on root.' });
    const right = await recordedRequirement(project.writer, {
      statement: 'Right also depends on root.',
    });
    const leaf = await recordedRequirement(project.writer, { statement: 'Leaf depends on left.' });
    const ref = (value: { requirementId: string; revisionId: string }) => ({
      entity_id: value.requirementId,
      revision_id: value.revisionId,
    });
    await dependsOn(project, ref(left), ref(root), 'Left depends on root.', root.sourceId);
    await dependsOn(project, ref(right), ref(root), 'Right depends on root.', root.sourceId);
    await dependsOn(project, ref(left), ref(right), 'Left also depends on right.', right.sourceId);
    await dependsOn(project, ref(leaf), ref(left), 'Leaf depends on left.', left.sourceId);

    const answer = await consequencesOf(project, root.requirementId);
    const reached = answerOf(answer.payload).affected.find(
      (entry) => entry.key === `requirement:${leaf.requirementId}`
    )!;

    expect(reached.paths).toHaveLength(2);
    expect(reached.paths.map((path) => path.length).sort()).toEqual([2, 3]);
    expect(reached.paths_omitted).toBe(0);
  });
});
