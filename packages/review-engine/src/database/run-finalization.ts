import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { executableIdentitySchema } from '@orcaops/review-core';
import { canonicalJson, uuidv7 } from '@orcaops/storage';
import { HistoryError } from '@orcaops/storage/history/authority';
import {
  type ProjectEvidenceFile,
  type ProjectOperationOptions,
  publishProjectEvidence,
} from '@orcaops/storage/history/database';

import { SEMANTIC_ANCHOR_INPUT_FILE, SEMANTIC_ANCHOR_RECEIPT_FILE } from '../semanticAnchors.js';
import { decodeRetainedReviewRecord, prepareReviewRecords, prepareReviewText } from './records.js';
import {
  cancelled,
  invalid,
  json,
  operationFields,
  performReviewOperation,
  revisionId,
  scanMetadata,
  stale,
  text,
  validate,
} from './request.js';
import { selection } from './reviews.js';
import { insertRunRevision } from './run-progress.js';
import { finalizationTargetSchema, prepareFinalizationWithDatabase } from './story-preparation.js';
import {
  buildTerminalRecord,
  prepareTerminalRecordBytes,
  type TerminalRecord,
} from './terminal-record.js';

const memberSchema = z.strictObject({ name: text, bytes: z.instanceof(Uint8Array) });
const publishSchema = z.strictObject({
  ...operationFields,
  reviewId: revisionId,
  runId: text,
  revisionId,
  publicationId: revisionId.nullable(),
  expected: finalizationTargetSchema,
  finalizedAt: z.iso.datetime(),
  runtimeIdentity: executableIdentitySchema.nullable(),
  runBytes: z.instanceof(Uint8Array),
  members: z.array(memberSchema),
});
export type PublishDatabaseReviewFinalization = Omit<
  z.infer<typeof publishSchema>,
  'runBytes' | 'members'
> & { runBytes: Uint8Array; members: { name: string; bytes: Uint8Array }[] };

export async function publishDatabaseReviewFinalization(
  raw: PublishDatabaseReviewFinalization,
  options: ProjectOperationOptions = {}
) {
  options = { signal: options.signal, onWait: options.onWait };
  const input = validate(publishSchema, raw);
  const [record] = prepareReviewRecords({
    records: [{ kind: 'run', bytes: input.runBytes }],
    secretAllow: input.secretAllow,
  });
  const run = decodeRetainedReviewRecord({ kind: 'run', bytes: record!.bytes });
  const members = input.members.map((member) => ({
    name: member.name,
    bytes: prepareReviewText({ bytes: member.bytes, secretAllow: input.secretAllow }).bytes,
  }));
  scanMetadata(
    {
      authority: input.authority,
      reviewId: input.reviewId,
      expected: input.expected,
      runtimeIdentity: input.runtimeIdentity,
      finalizedAt: input.finalizedAt,
      names: members.map((member) => member.name),
    },
    input.secretAllow
  );
  const sealed = run.value.finalized;
  if (run.value.run_id !== input.runId || sealed?.at !== input.finalizedAt)
    invalid('Retain the original run and authored finalization timestamp');
  if (
    (sealed.outcome === 'FAILED') !== (input.publicationId === null) ||
    (sealed.outcome === 'FAILED' && members.length !== 0)
  )
    invalid(
      'A failed run has no Story publication; other terminal outcomes retain their complete Story'
    );
  let prepared: Awaited<ReturnType<typeof prepareFinalizationWithDatabase>>;
  let coreDescriptors: ProjectEvidenceFile[] = [];
  let semanticDescriptors: ProjectEvidenceFile[] = [];
  let semanticPublicationId: string | null = null;
  let semanticMembers: { name: string; bytes: Buffer }[] = [];
  let semanticReceipt: TerminalRecord['semantic_anchor_input'];
  let terminal: ReturnType<typeof prepareTerminalRecordBytes>;
  return performReviewOperation(
    {
      authority: input.authority,
      operation: {
        operationId: input.operationId,
        kind: 'review.run.finalize',
        target: { reviewId: input.reviewId, runId: input.runId },
        payload: {
          revisionId: input.revisionId,
          publicationId: input.publicationId,
          finalizedAt: input.finalizedAt,
          runtimeIdentity: json(input.runtimeIdentity),
          runBytes: run.bytes.toString('base64'),
          members: members.map((member) => ({
            name: member.name,
            bytes: member.bytes.toString('base64'),
          })),
        },
        expectedState: json(input.expected),
        intentChange: false,
      },
      async prepareReadOnly(database) {
        prepared = await prepareFinalizationWithDatabase(database, input, options);
        if (
          !isDeepStrictEqual(run.value, JSON.parse(prepared.runBytes.toString('utf8'))) ||
          members.length !== prepared.requiredMembers.length ||
          members.some(
            (member, i) =>
              member.name !== prepared.requiredMembers[i]!.name ||
              !member.bytes.equals(prepared.requiredMembers[i]!.bytes)
          )
        )
          invalid('Retain the exact prepared run and core Story bytes for this original target');
      },
      async prepareEvidence(database) {
        const optional = prepared.semanticPreparation;
        semanticMembers = [
          ...(optional.payload === null
            ? []
            : [{ name: SEMANTIC_ANCHOR_INPUT_FILE, bytes: Buffer.from(optional.payload) }]),
          {
            name: SEMANTIC_ANCHOR_RECEIPT_FILE,
            bytes: Buffer.from(JSON.stringify(optional.receipt, null, 2) + '\n'),
          },
        ];
        semanticPublicationId = uuidv7();
        try {
          semanticDescriptors = await publishProjectEvidence(
            database,
            {
              publicationId: semanticPublicationId,
              members: semanticMembers,
              secretAllow: input.secretAllow,
            },
            { signal: options.signal }
          );
          semanticReceipt = { ...optional.receipt, receipt_file: SEMANTIC_ANCHOR_RECEIPT_FILE };
        } catch (cause) {
          cancelled(options.signal);
          if (!(cause instanceof HistoryError) || cause.code !== 'HISTORY_UNWRITABLE') throw cause;
          semanticPublicationId = null;
          semanticDescriptors = [];
          semanticReceipt = {
            ...optional.receipt,
            status: 'UNAVAILABLE',
            reason: 'PREPARED_INPUT_WRITE_FAILED',
            error_message: 'Optional semantic evidence could not be durably published',
            payload_file: null,
            receipt_file: null,
          };
        }
        cancelled(options.signal);
        if (input.publicationId !== null)
          coreDescriptors = await publishProjectEvidence(
            database,
            {
              publicationId: input.publicationId,
              members,
              secretAllow: input.secretAllow,
            },
            { signal: options.signal }
          );
        terminal = prepareTerminalRecordBytes({
          bytes: Buffer.from(
            JSON.stringify(
              buildTerminalRecord({
                ...prepared.terminalInputs,
                semanticInput: semanticReceipt,
              }),
              null,
              2
            ) + '\n'
          ),
          secretAllow: input.secretAllow,
        });
      },
      settle(tx) {
        const current = selection(tx, input.reviewId);
        if (
          current.floor_publication_id !== input.expected.floorPublicationId ||
          current.membership_revision_id !== input.expected.membershipRevisionId ||
          current.story_version !== input.expected.storyVersion
        )
          stale(
            'The reviewed scope or selected Story changed; retain the original finalization target'
          );
        insertRunRevision(tx, {
          reviewId: input.reviewId,
          runId: input.runId,
          revisionId: input.revisionId,
          operationId: input.operationId,
          expected: input.expected,
          bytes: run.bytes,
          sha256: run.sha256,
          run: run.value,
          floorPublicationId: input.expected.floorPublicationId,
          membershipRevisionId: input.expected.membershipRevisionId,
        });
        const floor = tx.get<{ floor_input_hash: string }>(
          'SELECT floor_input_hash FROM review_evidence_publications WHERE publication_id = ? AND review_id = ?',
          input.expected.floorPublicationId,
          input.reviewId
        );
        if (!floor)
          stale('The retained floor is missing; preserve its identity for explicit repair');
        const publications = [
          ...(input.publicationId === null
            ? []
            : [
                {
                  id: input.publicationId,
                  kind: 'story',
                  generation: prepared.generation,
                  members: prepared.requiredMembers,
                  descriptors: coreDescriptors,
                },
              ]),
          ...(semanticPublicationId === null
            ? []
            : [
                {
                  id: semanticPublicationId,
                  kind: 'semantic',
                  generation: prepared.generation,
                  members: semanticMembers.map((member) => ({
                    ...member,
                    schemaVersion: prepared.semanticPreparation.receipt.schema_version,
                  })),
                  descriptors: semanticDescriptors,
                },
              ]),
        ];
        for (const publication of publications) {
          tx.run(
            'INSERT INTO review_evidence_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            publication.id,
            input.reviewId,
            publication.kind,
            input.operationId,
            input.expected.membershipRevisionId,
            input.expected.floorPublicationId,
            floor.floor_input_hash,
            input.runId,
            input.revisionId,
            publication.generation,
            canonicalJson({
              outcome: prepared.outcome,
              observedWriteSequence: prepared.counters.writeSequence,
            })
          );
          for (let i = 0; i < publication.members.length; i++) {
            const member = publication.members[i]!;
            const descriptor = publication.descriptors[i]!;
            tx.run(
              'INSERT INTO review_evidence_members VALUES (?, ?, ?, ?, ?, ?, ?)',
              publication.id,
              member.name,
              publication.kind,
              member.schemaVersion,
              descriptor.relativePath,
              descriptor.sha256,
              descriptor.byteLength
            );
          }
        }
        tx.run(
          'INSERT INTO review_run_finalizations VALUES (?, ?, ?, ?, ?, ?)',
          input.runId,
          input.reviewId,
          input.revisionId,
          input.operationId,
          terminal.bytes,
          terminal.sha256
        );
        if (input.publicationId !== null)
          tx.run(
            'UPDATE review_selections SET story_publication_id = ?, story_version = story_version + 1, semantic_publication_id = ?, semantic_version = semantic_version + 1 WHERE review_id = ?',
            input.publicationId,
            semanticPublicationId,
            input.reviewId
          );
        return {
          reviewId: input.reviewId,
          runId: input.runId,
          revisionId: input.revisionId,
          version: input.expected.version + 1,
          publicationId: input.publicationId,
          semanticPublicationId,
          generation: prepared.generation,
          outcome: prepared.outcome,
          terminalBytes: terminal.bytes.toString('base64'),
          terminalHash: terminal.sha256,
          terminal: json(terminal.value),
        };
      },
    },
    options
  );
}
