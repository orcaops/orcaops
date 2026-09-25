import { expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  createProjectRequirement,
  openProjectDatabase,
  publishProjectKnowledgeSource,
  publishProjectSelection,
  readProjectArtifact,
} from '@orcaops/storage/history/database';
import { digest } from '@orcaops/storage/history/primitives';

import { capturedReviewFixture } from '../../tests/capturedReviewFixture.js';
import { accountProjectionSchema, forensicInputSchema } from '../dossier.js';
import { laneMarkdown } from '../twolaneRunCli.js';
import { defaultRunInputPolicy, prepareDatabaseReviewRunInputs } from './run-inputs.js';

const GENERATED_AT = '2026-09-19T12:00:00.000Z';
const OWNER = {
  identity: 'owner@example.test',
  basis: 'agent_reported_user_instruction' as const,
};
const BY_OWNER = { kind: 'actor' as const, actor: OWNER };

it('retains conflicting task-local authority in the exact account input only', async () => {
  const fixture = await capturedReviewFixture();
  const writer = await openProjectDatabase({ authority: fixture.authority, mode: 'writer' });
  const statements = [
    'Only task one may use the compact charge format.',
    'Only task two may use the expanded charge format.',
  ];
  const requirements: string[] = [];
  try {
    for (const [index, artifact] of fixture.artifacts.entries()) {
      const retained = readProjectArtifact(writer, artifact.artifactId)!;
      const planEventId = retained.thread.plan!.source_event_id;
      const requirementId = artifact.criterionIds[0]!;
      const published = await publishProjectKnowledgeSource(writer, {
        operationId: uuidv7(),
        source: {
          source_id: uuidv7(),
          occurrence: {
            kind: 'capture_field',
            artifact_id: artifact.artifactId,
            event_id: planEventId,
            field_path: 'plan_steps[0].acceptance_criteria[0].text',
            position: 0,
          },
          source_author: BY_OWNER.actor,
          interpreted_by: null,
          access_restriction: null,
        },
        recordedBy: BY_OWNER.actor,
        secretAllow: [],
      });
      const revision = {
        requirement_id: requirementId,
        revision_id: uuidv7(),
        previous_revision_id: null,
        statement: statements[index]!,
        rationale: 'Each review member retains its own local authority.',
        subject: null,
        applicability: { all_of: [] },
        duration: { kind: 'continuing' as const },
        source_ids: [published.value.sourceId],
        passages: [],
        source_standing: 'explicit_instruction' as const,
        recorded_at: GENERATED_AT,
      };
      await createProjectRequirement(writer, {
        operationId: uuidv7(),
        identity: {
          requirement_id: requirementId,
          origin: {
            kind: 'promoted_criterion',
            criterion: {
              artifact_id: artifact.artifactId,
              plan_event_id: planEventId,
              criterion_id: requirementId,
            },
          },
        },
        revision,
        attributedTo: BY_OWNER,
        secretAllow: [],
      });
      const scope = { kind: 'artifact' as const, artifact_id: artifact.artifactId };
      const instructionBytes = Buffer.from(
        `Adopt the local charge-format requirement for ${artifact.artifactId}.`
      );
      const instruction = await publishProjectKnowledgeSource(writer, {
        operationId: uuidv7(),
        source: {
          source_id: uuidv7(),
          occurrence: {
            kind: 'user_instruction',
            retention: { kind: 'bytes', content_sha256: digest(instructionBytes) },
            location: `review fixture instruction ${index}`,
            source_time: GENERATED_AT,
          },
          source_author: BY_OWNER.actor,
          interpreted_by: null,
          access_restriction: null,
        },
        recordedBy: BY_OWNER.actor,
        retainedBytes: instructionBytes,
        secretAllow: [],
      });
      await publishProjectSelection(writer, {
        operationId: uuidv7(),
        selection: {
          selection_id: uuidv7(),
          kind: 'accepted',
          target: {
            kind: 'requirement',
            entity_id: requirementId,
            revision_id: revision.revision_id,
          },
          scope,
          designation: 'adopted',
          authorization: {
            kind: 'explicit_instruction',
            instruction_source_id: instruction.value.sourceId,
            scope,
          },
          expected_state: { kind: 'initial' },
        },
        selectedBy: OWNER,
        acceptedAt: GENERATED_AT,
        secretAllow: [],
      });
      requirements.push(requirementId);
    }
  } finally {
    writer.close();
  }

  const published = await fixture.publishFloor();
  const selection = await fixture.read(
    (database) =>
      database.read((view) =>
        view.get<{
          membershipRevisionId: string;
          membershipVersion: number;
          baseRevisionId: string | null;
          baseVersion: number;
          floorVersion: number;
        }>(
          `SELECT membership_revision_id AS membershipRevisionId,
                  membership_version AS membershipVersion,
                  base_revision_id AS baseRevisionId,
                  base_version AS baseVersion,
                  floor_version AS floorVersion
             FROM review_selections WHERE review_id = ?`,
          published.review_id
        )
      ).value!
  );
  const prepared = await prepareDatabaseReviewRunInputs({
    authority: fixture.authority,
    reviewId: published.review_id,
    expected: {
      ...selection,
      floorPublicationId: published.publication_id,
    },
    policy: defaultRunInputPolicy(),
    generatedAt: GENERATED_AT,
    secretAllow: [],
  });
  const projection = prepared.values['account-projection-v1.json'] as {
    taskKnowledge: {
      tasks: {
        artifactId: string;
        knowledge: { entries: { key: string; placement: string; statement: string | null }[] };
      }[];
    };
  };
  expect(projection.taskKnowledge.tasks).toHaveLength(2);
  for (const [index, artifact] of fixture.artifacts.entries()) {
    const task = projection.taskKnowledge.tasks.find(
      (candidate) => candidate.artifactId === artifact.artifactId
    )!;
    const own = task.knowledge.entries.find(
      (entry) => entry.key === `requirement:${requirements[index]}`
    );
    const other = task.knowledge.entries.find(
      (entry) => entry.key === `requirement:${requirements[1 - index]}`
    );
    expect(own).toMatchObject({ placement: 'applicable', statement: statements[index] });
    expect(other).toMatchObject({ placement: 'background', statement: statements[1 - index] });
  }

  const retained = (name: 'account-projection-v1.json' | 'forensic-input-v1.json') =>
    JSON.parse(prepared.members.find((member) => member.name === name)!.bytes.toString('utf8'));
  const inputs = {
    projection: accountProjectionSchema.parse(retained('account-projection-v1.json')),
    forensicInput: forensicInputSchema.parse(retained('forensic-input-v1.json')),
  };
  expect(inputs.projection).toEqual(prepared.values['account-projection-v1.json']);
  const account = laneMarkdown('account', 'task-knowledge-run', inputs);
  const forensic = laneMarkdown('forensic', 'task-knowledge-run', inputs);
  for (const statement of statements) {
    expect(account).toContain(statement);
    expect(forensic).not.toContain(statement);
  }
  expect(account).toContain('this answer claims no completeness');
}, 30_000);
