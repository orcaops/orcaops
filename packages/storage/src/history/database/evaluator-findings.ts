import { createHash } from 'node:crypto';
import { z } from 'zod';

import type {
  EvaluatorFinding,
  EvaluatorFindingsNotice,
  EvaluatorFindingsUnreadable,
} from '@orcaops/evaluator-protocol';

import type { RetainedArtifactEvent } from './artifact-events.js';
import { refuseJsonBytes } from './authored-bytes.js';
import type { ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type EvaluatorRunBasis,
  type EvaluatorRunEvidence,
  EvaluatorRunEvidenceSchema,
} from './evaluator-findings-input.js';
import { insertObservation } from './knowledge-observations.js';
import {
  type EvaluatorRunObservationRecords,
  evaluatorRunObservationRecords,
} from './knowledge-run-observations.js';
import type { ProjectSettlement } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';

/**
 * The run an evidence record attaches to has to be one this very settlement establishes. Both
 * shapes that carry a run are read for exactly the two fields the retained rows copy: a
 * standalone `evaluator_run_recorded` payload, and the delta rows a `checkpoint_opened` event
 * embeds under `gate_audit`, whose artifact is the parent event's.
 */
const RunEventSchema = z
  .object({
    run_id: z.string().min(1),
    evaluator_ref: z.string().min(1),
    // What the run event says became of the producer. Only a completed run observed anything: a
    // skipped one and a consent refusal are recorded so the refusal stays loud, and an error run
    // is one whose producer did not complete. A payload that says nothing says no producer ran.
    run_status: z.string().optional(),
  })
  .loose();
const GateAuditEventSchema = z
  .object({ gate_audit: z.object({ runs: z.array(RunEventSchema).default([]) }).loose() })
  .loose();

interface EstablishedRun {
  artifactId: string;
  evaluatorRef: string;
  /** Where the run is stated, which is the occurrence its observation's source names. */
  eventId: string;
  fieldPath: string;
  position: number;
  /** Whether the producer ran: only then is there an execution to observe. */
  ran: boolean;
}

function runsOfSettlement(
  artifactId: string,
  incoming: readonly RetainedArtifactEvent[]
): Map<string, EstablishedRun> {
  const runs = new Map<string, EstablishedRun>();
  for (const { event } of incoming) {
    const eventId = event.record.event_id;
    if (event.record.type === 'evaluator_run_recorded') {
      const run = RunEventSchema.safeParse(event.payload);
      if (run.success)
        runs.set(run.data.run_id, {
          artifactId,
          evaluatorRef: run.data.evaluator_ref,
          eventId,
          fieldPath: 'payload',
          position: 0,
          ran: run.data.run_status === 'completed',
        });
      continue;
    }
    if (event.record.type !== 'checkpoint_opened') continue;
    const open = GateAuditEventSchema.safeParse(event.payload);
    if (!open.success) continue;
    open.data.gate_audit.runs.forEach((run, position) =>
      runs.set(run.run_id, {
        artifactId,
        evaluatorRef: run.evaluator_ref,
        eventId,
        fieldPath: 'payload.gate_audit.runs',
        position,
        ran: run.run_status === 'completed',
      })
    );
  }
  return runs;
}

/**
 * The observation a run that ran is, with the source occurrence it was read from, and the authored
 * bytes of each. Absent when the run's context names no digest: without one there is no input this
 * record could say the producer consumed, so there is no honest execution to record.
 */
interface PreparedRunObservation extends EvaluatorRunObservationRecords {
  readonly sourceBytes: Buffer;
  readonly observationBytes: Buffer;
}

interface PreparedEvidenceEntry {
  readonly runId: string;
  readonly run: EstablishedRun;
  readonly basis: EvaluatorRunBasis;
  readonly basisBytes: Buffer;
  readonly findings: EvaluatorRunEvidence['findings'];
  readonly findingsBytes: Buffer | null;
  readonly observation: PreparedRunObservation | null;
}

export interface PreparedEvaluatorEvidence {
  readonly entries: readonly PreparedEvidenceEntry[];
  /** What the operation receipt compares, so a retry that changed a finding is refused. */
  readonly digest: string;
  /** The parsed handover, retained with a pending capture so a resumed one settles the same. */
  readonly evidence: readonly EvaluatorRunEvidence[];
}

function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The basis is retained as its own JSON record beside its lookup columns. The producer payload is
 * named by its hash here and kept whole in its own column, because it is bytes rather than JSON.
 */
function basisRecord(runId: string, basis: EvaluatorRunBasis): Buffer {
  return Buffer.from(
    canonicalJson({
      run_id: runId,
      context_sha256: basis.context_sha256,
      base_sha: basis.base_sha,
      head_sha: basis.head_sha,
      evaluator_version: basis.evaluator_version,
      producer_payload_sha256:
        basis.producer_payload === null ? null : sha256(basis.producer_payload),
    })
  );
}

/**
 * Validate a settlement's evidence outside the transaction. A record naming a run this settlement
 * does not establish is refused before anything is written; a run with no handover contributes
 * nothing, which is not the same as a handover that establishes nothing.
 *
 * `authored` is what the events on the same call are read under. Retained evidence is scanned for
 * refused content exactly once, when it is authored: a two-phase capture is admitted with the
 * project's allowlist and settled from what it retained, with no allowlist to read it under, so
 * scanning again there would refuse on restore what was deliberately allowed on admission — and
 * would do it on every read of the pending capture, not only on the settlement.
 */
export function prepareEvaluatorEvidence(input: {
  artifactId: string;
  incoming: readonly RetainedArtifactEvent[];
  evidence: readonly unknown[];
  secretAllow: readonly string[];
  authored: boolean;
}): PreparedEvaluatorEvidence | null {
  if (!Array.isArray(input.evidence))
    invalid('Supply retained evaluator evidence as an explicit array');
  if (input.evidence.length === 0) return null;
  const runs = runsOfSettlement(input.artifactId, input.incoming);
  const seen = new Set<string>();
  const evidence: EvaluatorRunEvidence[] = [];
  const entries = input.evidence.map((candidate) => {
    const parsed = EvaluatorRunEvidenceSchema.safeParse(candidate);
    if (!parsed.success)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Provide the exact evaluator findings handover for each run this settlement establishes',
        { cause: parsed.error }
      );
    const entry = parsed.data;
    if (seen.has(entry.run_id))
      invalid('Each evaluator run hands over what became of its findings once');
    seen.add(entry.run_id);
    const run = runs.get(entry.run_id);
    if (!run)
      invalid(
        'Retained evaluator findings must name a run this settlement establishes; retain the run and its findings together'
      );
    if (entry.findings.status !== 'none' && entry.findings.record.run_id !== entry.run_id)
      invalid('A findings record names the run it was established for');
    const basisBytes = basisRecord(entry.run_id, entry.basis);
    if (input.authored) refuseJsonBytes(basisBytes, input.secretAllow);
    let findingsBytes: Buffer | null = null;
    if (entry.findings.status !== 'none') {
      findingsBytes = Buffer.from(canonicalJson(entry.findings.record));
      if (input.authored) refuseJsonBytes(findingsBytes, input.secretAllow);
    }
    // A run that ran becomes an observation in this same settlement, so a claim revision can rest
    // on it by name. A skipped run, a consent refusal and a run that errored before its producer
    // completed are all recorded as runs and observe nothing: they established no execution, and
    // the run event's own status is what says so rather than the caller's handover.
    let observation: PreparedRunObservation | null = null;
    if (run.ran && entry.basis.context_sha256 !== null) {
      const records = evaluatorRunObservationRecords({
        runId: entry.run_id,
        artifactId: run.artifactId,
        eventId: run.eventId,
        fieldPath: run.fieldPath,
        position: run.position,
        evaluatorRef: run.evaluatorRef,
        contextSha256: entry.basis.context_sha256,
        baseSha: entry.basis.base_sha,
        headSha: entry.basis.head_sha,
      });
      const sourceBytes = Buffer.from(canonicalJson(records.source));
      const observationBytes = Buffer.from(canonicalJson(records.observation));
      if (input.authored) {
        refuseJsonBytes(sourceBytes, input.secretAllow);
        refuseJsonBytes(observationBytes, input.secretAllow);
      }
      observation = { ...records, sourceBytes, observationBytes };
    }
    evidence.push(entry);
    return {
      runId: entry.run_id,
      run,
      basis: entry.basis,
      basisBytes,
      findings: entry.findings,
      findingsBytes,
      observation,
    };
  });
  return {
    entries,
    digest: sha256(Buffer.from(canonicalJson(evidence))),
    evidence,
  };
}

/**
 * The source occurrence a run is stated at, and the observation of it. The source names the event
 * and owns no second copy of its bytes, exactly as any other capture field does.
 */
function settleRunObservation(
  transaction: ProjectSettlement,
  runId: string,
  prepared: PreparedRunObservation,
  operationId: string
): void {
  const occurrence = prepared.source.occurrence;
  transaction.run(
    `INSERT INTO knowledge_sources (source_id,source_kind,artifact_id,event_id,field_path,position,
      retention_kind,retained_bytes,retained_reference,content_sha256,
      source_author,source_author_basis,recorded_by,recorded_by_basis,
      interpreted_kind,interpreted_by,interpreted_by_basis,access_restriction,
      record_bytes,record_sha256,operation_id)
      VALUES (?,'capture_field',?,?,?,?,NULL,NULL,NULL,NULL,NULL,'unknown',NULL,'unknown',NULL,NULL,NULL,NULL,?,?,?)`,
    prepared.source.source_id,
    occurrence.artifact_id,
    occurrence.event_id,
    occurrence.field_path,
    occurrence.position,
    prepared.sourceBytes,
    sha256(prepared.sourceBytes),
    operationId
  );
  insertObservation(
    transaction,
    prepared.observation,
    { bytes: prepared.observationBytes, sha256: sha256(prepared.observationBytes) },
    operationId,
    runId
  );
}

export function settleEvaluatorEvidence(
  transaction: ProjectSettlement,
  prepared: PreparedEvaluatorEvidence,
  operationId: string
): void {
  for (const entry of prepared.entries) {
    transaction.run(
      `INSERT INTO evaluator_run_contexts (run_id,artifact_id,evaluator_ref,evaluator_version,
        context_sha256,base_sha,head_sha,producer_payload_bytes,producer_payload_sha256,
        record_bytes,record_sha256,operation_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      entry.runId,
      entry.run.artifactId,
      entry.run.evaluatorRef,
      entry.basis.evaluator_version,
      entry.basis.context_sha256,
      entry.basis.base_sha,
      entry.basis.head_sha,
      entry.basis.producer_payload === null ? null : Buffer.from(entry.basis.producer_payload),
      entry.basis.producer_payload === null ? null : sha256(entry.basis.producer_payload),
      entry.basisBytes,
      sha256(entry.basisBytes),
      operationId
    );
    if (entry.observation)
      settleRunObservation(transaction, entry.runId, entry.observation, operationId);
    if (entry.findings.status === 'none') continue;
    const bytes = entry.findingsBytes!;
    if (entry.findings.status === 'unreadable') {
      transaction.run(
        `INSERT INTO evaluator_findings_unreadable (run_id,artifact_id,evaluator_ref,source,detail,
          record_bytes,record_sha256,operation_id) VALUES (?,?,?,?,?,?,?,?)`,
        entry.runId,
        entry.run.artifactId,
        entry.run.evaluatorRef,
        entry.findings.record.source,
        entry.findings.record.detail,
        bytes,
        sha256(bytes),
        operationId
      );
      continue;
    }
    const record = entry.findings.record;
    transaction.run(
      `INSERT INTO evaluator_run_findings (run_id,artifact_id,evaluator_ref,finding_count,
        notice_json,record_bytes,record_sha256,operation_id) VALUES (?,?,?,?,?,?,?,?)`,
      entry.runId,
      entry.run.artifactId,
      entry.run.evaluatorRef,
      record.findings.length,
      record.notice === undefined ? null : canonicalJson(record.notice),
      bytes,
      sha256(bytes),
      operationId
    );
    record.findings.forEach((finding, position) =>
      transaction.run(
        `INSERT INTO evaluator_findings (run_id,position,artifact_id,evaluator_ref,finding_key,
          title,detail,locations_json,conclusion,operation_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        entry.runId,
        position,
        entry.run.artifactId,
        entry.run.evaluatorRef,
        finding.key ?? null,
        finding.title,
        finding.detail ?? null,
        finding.locations === undefined ? null : canonicalJson(finding.locations),
        finding.conclusion ?? null,
        operationId
      )
    );
  }
}

/**
 * What a pending capture retains of its handover, so the settlement that finishes it writes what
 * the interrupted one would have. The producer payload is kept in its own column because it is
 * bytes, and the record it is missing from is put back together on the way out.
 */
export function pendingEvaluatorEvidenceRows(
  prepared: PreparedEvaluatorEvidence
): { runId: string; bytes: Buffer; producerPayload: Buffer | null }[] {
  return prepared.evidence.map((entry) => {
    const { producer_payload, ...basis } = entry.basis;
    return {
      runId: entry.run_id,
      bytes: Buffer.from(canonicalJson({ run_id: entry.run_id, findings: entry.findings, basis })),
      producerPayload: producer_payload === null ? null : Buffer.from(producer_payload),
    };
  });
}

export function restorePendingEvaluatorEvidence(
  rows: readonly { bytes: Buffer; producerPayload: Buffer | null }[]
): EvaluatorRunEvidence[] {
  return rows.map((row) => {
    const retained = JSON.parse(row.bytes.toString('utf8')) as {
      basis: Record<string, unknown>;
    };
    const parsed = EvaluatorRunEvidenceSchema.safeParse({
      ...retained,
      basis: {
        ...retained.basis,
        producer_payload:
          row.producerPayload === null ? null : Uint8Array.from(row.producerPayload),
      },
    });
    if (!parsed.success)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'A pending capture retains evaluator evidence this build cannot read; preserve history for explicit repair',
        { cause: parsed.error }
      );
    return parsed.data;
  });
}

export interface ProjectEvaluatorRunBasis {
  runId: string;
  artifactId: string;
  evaluatorRef: string;
  evaluatorVersion: string | null;
  contextSha256: string | null;
  baseSha: string | null;
  headSha: string | null;
  producerPayload: Buffer | null;
  producerPayloadSha256: string | null;
  recordSha256: string;
  operationId: string;
}

export interface ProjectEvaluatorFinding {
  runId: string;
  position: number;
  artifactId: string;
  evaluatorRef: string;
  key: string | null;
  title: string;
  detail: string | null;
  locations: EvaluatorFinding['locations'];
  conclusion: EvaluatorFinding['conclusion'];
  operationId: string;
}

/**
 * What a run's findings read as. `not-retained` is a run this build wrote nothing for — one
 * retained before these tables existed, or one whose producer was never asked — and it is
 * deliberately a different answer from `none`, which is a run whose producer offered no finding.
 * Neither is a finding identity, and reading either invents none.
 */
export type ProjectEvaluatorRunFindings =
  | { status: 'not-retained' }
  | { status: 'none'; basis: ProjectEvaluatorRunBasis }
  | {
      status: 'established';
      basis: ProjectEvaluatorRunBasis;
      recordSha256: string;
      recordBytes: Buffer;
      notice: EvaluatorFindingsNotice | null;
      findings: ProjectEvaluatorFinding[];
    }
  | {
      status: 'unreadable';
      basis: ProjectEvaluatorRunBasis;
      recordSha256: string;
      recordBytes: Buffer;
      source: EvaluatorFindingsUnreadable['source'];
      detail: string;
    };

// Blobs cross the read view as hexadecimal: it materializes plain JSON and refuses a Buffer.
const BASIS_COLUMNS = `run_id AS runId, artifact_id AS artifactId, evaluator_ref AS evaluatorRef,
  evaluator_version AS evaluatorVersion, context_sha256 AS contextSha256, base_sha AS baseSha,
  head_sha AS headSha,
  CASE WHEN producer_payload_bytes IS NULL THEN NULL ELSE hex(producer_payload_bytes) END AS producerPayload,
  producer_payload_sha256 AS producerPayloadSha256, record_sha256 AS recordSha256,
  operation_id AS operationId`;
const FINDING_COLUMNS = `run_id AS runId, position, artifact_id AS artifactId,
  evaluator_ref AS evaluatorRef, finding_key AS key, title, detail,
  locations_json AS locations, conclusion, operation_id AS operationId`;

interface FindingRow extends Omit<ProjectEvaluatorFinding, 'locations'> {
  locations: string | null;
}

const decodeFinding = (row: FindingRow): ProjectEvaluatorFinding => ({
  ...row,
  locations:
    row.locations === null
      ? undefined
      : (JSON.parse(row.locations) as EvaluatorFinding['locations']),
  conclusion: row.conclusion ?? undefined,
});

// Bytes leave the read view as hexadecimal and are decoded outside it: a materialized read
// carries plain JSON, and a Buffer is neither on the way in nor on the way out.
type RetainedRunFindings =
  | { status: 'not-retained' }
  | { status: 'none'; basis: RetainedBasisRow }
  | {
      status: 'established';
      basis: RetainedBasisRow;
      recordSha256: string;
      recordBytes: string;
      notice: string | null;
      findings: FindingRow[];
    }
  | {
      status: 'unreadable';
      basis: RetainedBasisRow;
      recordSha256: string;
      recordBytes: string;
      source: EvaluatorFindingsUnreadable['source'];
      detail: string;
    };
type RetainedBasisRow = Omit<ProjectEvaluatorRunBasis, 'producerPayload'> & {
  producerPayload: string | null;
};

function selectRunFindings(view: ProjectReadView, runId: string): RetainedRunFindings {
  const basis = view.get<RetainedBasisRow>(
    `SELECT ${BASIS_COLUMNS} FROM evaluator_run_contexts WHERE run_id = ?`,
    runId
  );
  if (!basis) return { status: 'not-retained' };
  const unreadable = view.get<{
    recordSha256: string;
    recordBytes: string;
    source: EvaluatorFindingsUnreadable['source'];
    detail: string;
  }>(
    `SELECT record_sha256 AS recordSha256, hex(record_bytes) AS recordBytes, source, detail
       FROM evaluator_findings_unreadable WHERE run_id = ?`,
    runId
  );
  if (unreadable) return { status: 'unreadable', basis, ...unreadable };
  const established = view.get<{
    recordSha256: string;
    recordBytes: string;
    notice: string | null;
  }>(
    `SELECT record_sha256 AS recordSha256, hex(record_bytes) AS recordBytes, notice_json AS notice
       FROM evaluator_run_findings WHERE run_id = ?`,
    runId
  );
  if (!established) return { status: 'none', basis };
  return {
    status: 'established',
    basis,
    ...established,
    findings: view.all<FindingRow>(
      `SELECT ${FINDING_COLUMNS} FROM evaluator_findings WHERE run_id = ? ORDER BY position`,
      runId
    ),
  };
}

const decodeBasis = (row: RetainedBasisRow): ProjectEvaluatorRunBasis => ({
  ...row,
  producerPayload: row.producerPayload === null ? null : Buffer.from(row.producerPayload, 'hex'),
});

export function readProjectEvaluatorRunFindings(
  handle: ProjectDatabase,
  runId: string
): ProjectEvaluatorRunFindings {
  if (typeof runId !== 'string' || runId.length === 0)
    invalid('Select an exact evaluator run identity');
  const retained = handle.read((view) => selectRunFindings(view, runId)).value;
  switch (retained.status) {
    case 'not-retained':
      return retained;
    case 'none':
      return { status: 'none', basis: decodeBasis(retained.basis) };
    case 'unreadable':
      return {
        status: 'unreadable',
        basis: decodeBasis(retained.basis),
        recordSha256: retained.recordSha256,
        recordBytes: Buffer.from(retained.recordBytes, 'hex'),
        source: retained.source,
        detail: retained.detail,
      };
    case 'established':
      return {
        status: 'established',
        basis: decodeBasis(retained.basis),
        recordSha256: retained.recordSha256,
        recordBytes: Buffer.from(retained.recordBytes, 'hex'),
        notice:
          retained.notice === null
            ? null
            : (JSON.parse(retained.notice) as EvaluatorFindingsNotice),
        findings: retained.findings.map(decodeFinding),
      };
  }
}

/**
 * Every earlier finding this evaluator has keyed the same way in this artifact, oldest first. The
 * answer never leaves the artifact: a finding cannot be reached from any other one, and a key
 * that matched across artifacts would be exactly that reach. A finding whose producer set no key
 * is unreachable here, because it has no cross-run identity to look up.
 */
export function findProjectEvaluatorFindingRecurrence(
  handle: ProjectDatabase,
  input: { artifactId: string; evaluatorRef: string; key: string }
): ProjectEvaluatorFinding[] {
  const { artifactId, evaluatorRef, key } = input;
  if (
    typeof artifactId !== 'string' ||
    !artifactId.length ||
    typeof evaluatorRef !== 'string' ||
    !evaluatorRef.length ||
    typeof key !== 'string' ||
    !key.length
  )
    invalid('Select an exact artifact, evaluator reference and finding key');
  return handle
    .read((view) =>
      view.all<FindingRow>(
        `SELECT ${FINDING_COLUMNS} FROM evaluator_findings
          WHERE artifact_id = ? AND evaluator_ref = ? AND finding_key = ?
          ORDER BY run_id, position`,
        artifactId,
        evaluatorRef,
        key
      )
    )
    .value.map(decodeFinding);
}
