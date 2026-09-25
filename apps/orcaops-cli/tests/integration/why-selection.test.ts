import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import {
  publishProjectContinuingDecisionRevision,
  publishProjectKnowledgeSource,
  readProjectArtifact,
} from '@orcaops/storage/history/database';

import { closeFingerprintedCheckpoint, commitFile } from '../helpers/database-fingerprint.js';
import { fixture } from '../helpers/database-history.js';
import { AT, OWNER } from '../helpers/knowledge-records.js';
import { makeAgent } from '../support/test-agent.js';

it.each(['navigation', 'delivery'])(
  'retains a differently worded central %s decision among candidate distractors',
  async (domain) => {
    const f = await fixture();
    const file = `packages/client-core/src/${domain}-contract.ts`;
    const openRef = f.context.headOid!;
    const closeRef = await commitFile(f, file, 'export const isolated = true;\n');
    const central = {
      decision: 'Separate destination meaning from platform actions.',
      reason: 'The platforms have incompatible lifecycle requirements.',
      alternatives_considered: [
        {
          option: 'Use a shared action planner.',
          rejected_because: 'A second lifecycle model can disagree with the platform.',
        },
      ],
    };
    const summary = `${domain} delegates lifecycle actions to platform owners.`;
    const artifact = await f.capture();
    await closeFingerprintedCheckpoint(f, artifact, {
      files: [file],
      openRef,
      closeRef,
      summary,
      decisions: [
        ...Array.from({ length: 40 }, (_, index) => ({
          decision: `Keep billing archive partition ${index}.`,
          reason: 'The client contract requires backward-compatible report names. '.repeat(5),
        })),
        central,
      ],
    });
    const event = readProjectArtifact(f.writer, artifact)!.thread.events.find(
      (entry) => entry.record.type === 'checkpoint_closed'
    )!.record.event_id;
    const passages = [];
    for (const [field, wording] of [
      ['decisions[40].decision', central.decision],
      ['summary', summary],
    ]) {
      const sourceId = uuidv7();
      await publishProjectKnowledgeSource(f.writer, {
        operationId: uuidv7(),
        source: {
          source_id: sourceId,
          occurrence: {
            kind: 'capture_field',
            artifact_id: artifact,
            event_id: event,
            field_path: field!,
            position: 0,
          },
          source_author: OWNER,
          interpreted_by: null,
          access_restriction: null,
        },
        recordedBy: OWNER,
        secretAllow: [],
      });
      passages.push({
        source_id: sourceId,
        location: field!,
        passage_sha256: createHash('sha256').update(wording!).digest('hex'),
      });
    }
    const identity = uuidv7();
    let previous: string | null = null;
    for (const passage of passages) {
      const revisionId = uuidv7();
      await publishProjectContinuingDecisionRevision(f.writer, {
        operationId: uuidv7(),
        attributedTo: { kind: 'actor', actor: OWNER },
        occurrence: { source_id: passage.source_id, location: passage.location },
        secretAllow: [],
        revision: {
          decision_id: identity,
          revision_id: revisionId,
          previous_revision_id: previous,
          chosen_approach: central.decision,
          rationale: central.reason,
          alternatives: [],
          assumptions: [],
          reconsideration_conditions: [],
          subject: null,
          derivation: null,
          applicability: { all_of: [] },
          source_ids: [passage.source_id],
          passages: [passage],
          source_standing: 'extracted_candidate',
          recorded_at: AT,
        },
      });
      previous = revisionId;
    }
    const agent = makeAgent({
      cwd: f.main,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    });
    const response = await agent.runRaw([
      'why',
      file,
      '--json',
      '--view',
      'rationale',
      '--limit',
      '5',
    ]);
    expect(response.exitCode, response.stderr || response.stdout).toBe(0);
    const answer = JSON.parse(response.stdout);
    expect(answer.output.bytes).toBe(Buffer.byteLength(response.stdout));
    expect(answer.output.bytes).toBeLessThanOrEqual(32_768);
    expect(answer.knowledge.rationale[0]).toMatchObject({
      form: 'recorded_capture',
      authority: 'recorded_account',
      account: {
        wording: central.decision,
        reason: central.reason,
        alternatives: central.alternatives_considered,
      },
      relevance: {
        basis: 'candidate_event',
        target: { kind: 'candidate_context' },
        support: { account_id: `${event}:summary`, target: { kind: 'target_terms' } },
      },
    });
    expect(answer.output.omitted_rationale).toBeGreaterThan(0);
    expect(answer.output.selection.stopped).toBe('selection_target');
    expect(answer.output.bytes).toBeLessThan(20_480);
    expect(JSON.stringify(answer.knowledge.rationale)).not.toContain('billing archive');
  }
);

it.each(['delivery', 'scheduling'])(
  'keeps direct %s explanations ahead of change-like criteria',
  async (domain) => {
    const f = await fixture();
    const file = `src/${domain}.ts`;
    const artifact = await f.capture(undefined, {
      criteria: Array.from({ length: 20 }, (_, index) => ({
        criterion_id: uuidv7(),
        text: `Remove retired ${domain} compatibility paths ${index}. ${'Record implementation and simulator execution details. '.repeat(50)}`,
      })),
    });
    const openRef = f.context.headOid!;
    const closeRef = await commitFile(f, file, 'export const durable = true;\n');
    const decisions = Array.from({ length: 6 }, (_, index) => ({
      decision: `Keep durable ${domain} ownership rule ${index} in ${file}.`,
      reason: `Rule ${index} prevents acknowledged work from being lost after a worker restart.`,
    }));
    await closeFingerprintedCheckpoint(f, artifact, {
      files: [file],
      openRef,
      closeRef,
      decisions,
    });
    const reversal = `Replace durable ${domain} ownership rule 0 with transactional acknowledgement.`;
    await f.capture(undefined, {
      decisions: [
        {
          decision: reversal,
          reason: 'A transaction prevents concurrent workers from losing acknowledged work.',
          revision_n: 0,
        },
      ],
    });
    const agent = makeAgent({
      cwd: f.main,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    });
    const response = await agent.runRaw(['why', file, '--json', '--view', 'rationale']);
    expect(response.exitCode, response.stderr || response.stdout).toBe(0);
    const answer = JSON.parse(response.stdout);
    const words = answer.knowledge.rationale.map(
      (item: { account?: { wording: string } }) => item.account?.wording
    );
    expect(words).toEqual(
      expect.arrayContaining([...decisions.map((decision) => decision.decision), reversal])
    );
    expect(words.some((word: string) => word?.startsWith('Remove retired'))).toBe(false);
    expect(answer.output.bytes).toBe(Buffer.byteLength(response.stdout));
    expect(answer.output.bytes).toBeLessThanOrEqual(20480);
    expect(answer.output.selection.target_bytes).toBe(20480);
  }
);
