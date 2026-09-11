import { realpath } from 'node:fs/promises';

import {
  assertNoSecretsInPayload,
  canonicalJson,
  type PullCacheRecord,
  PullCacheRecordSchema,
  SecretInPayloadError,
} from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import {
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
  publishProjectSourcePlanLocator,
  publishProjectSourcePlanRecord,
  readProjectApprovedSourcePlan,
  readProjectSourcePlanLocator,
  readProjectSourcePlanNamespace,
  type SourcePlanNamespace,
} from '@orcaops/storage/history/database';
import { canonicalRemoteTarget, type RemoteTarget } from '@orcaops/storage/history/remote-target';

import { toSecretFindingReport } from './cloud-secret-gate.js';
import type { PlanPullPersistence } from '../commands/plan/pull.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

type RecordPublication = Awaited<ReturnType<typeof publishProjectSourcePlanRecord>>;
type LocatorPublication = Awaited<ReturnType<typeof publishProjectSourcePlanLocator>>;

export interface DatabasePlanPullState {
  record: RecordPublication | null;
  locator: LocatorPublication | null;
}

export interface DatabasePlanPullPersistence extends PlanPullPersistence {
  state(): DatabasePlanPullState;
}

export interface DatabasePlanPullPersistenceOptions {
  reader: ProjectDatabase;
  target: RemoteTarget;
  secretAllow: readonly string[];
  openWriter(): Promise<ProjectDatabase>;
  signal?: AbortSignal;
  onWait?: ProjectOperationOptions['onWait'];
}

function derivedId(projectId: string, family: string, value: unknown): string {
  return artifactOperationId(projectId, canonicalJson(value), family);
}

function refusePlanPullPayload(
  value: unknown,
  secretAllow: readonly string[],
  persisted: 'nothing' | 'record-and-file'
): void {
  try {
    assertNoSecretsInPayload(value, secretAllow);
  } catch (cause) {
    if (!(cause instanceof SecretInPayloadError)) throw cause;
    throw new OrcaopsError(
      ErrorCodes.SECRET_IN_PAYLOAD,
      `${cause.message} ${
        persisted === 'nothing'
          ? 'The approved cloud plan was read, but no Source Plan record or output file was written.'
          : 'The approved Source Plan record and output file were written, but path lineage was not persisted.'
      }`,
      'plan-pull',
      { secret_findings: cause.findings.map(toSecretFindingReport) }
    );
  }
}

export function createDatabasePlanPullPersistence(
  input: DatabasePlanPullPersistenceOptions
): DatabasePlanPullPersistence {
  const reader = input.reader;
  const target = canonicalRemoteTarget(input.target);
  const secretAllow = [...input.secretAllow];
  const projectId = reader.authority.projectId;
  let namespace: Extract<SourcePlanNamespace, { scopeKind: 'account' }> | null = null;
  let record: RecordPublication | null = null;
  let approvedKey: { externalId: string; versionNumber: number } | null = null;
  let locator: LocatorPublication | null = null;

  function readNamespace() {
    namespace ??= readProjectSourcePlanNamespace(reader, {
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
    }) ?? {
      namespaceId: derivedId(projectId, 'source_plan.namespace', target),
      scopeKind: 'account' as const,
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
      originalNamespaceHash: null,
      originalLocatorHash: null,
    };
    return namespace;
  }

  async function publish<T>(run: (writer: ProjectDatabase) => Promise<T>): Promise<T> {
    const writer = await input.openWriter();
    try {
      return await run(writer);
    } finally {
      writer.close();
    }
  }

  return {
    async preflight() {
      readNamespace();
    },
    async writeRecord(value: PullCacheRecord) {
      const parsed = PullCacheRecordSchema.parse(value);
      const scope = readNamespace();
      if (parsed.base_url !== target.server_url || parsed.org_id !== target.org_id)
        throw new ProjectDatabaseError(
          'AUTHORITY_MISMATCH',
          'The approved Source Plan belongs to another authenticated target'
        );
      const recordBytes = Buffer.from(canonicalJson(parsed) + '\n', 'utf8');
      refusePlanPullPayload({ namespace: scope, record: parsed }, secretAllow, 'nothing');
      const identity = { target, record: parsed };
      record = await publish((writer) =>
        publishProjectSourcePlanRecord(
          writer,
          {
            operationId: derivedId(projectId, 'source_plan.pull.operation', identity),
            recordId: derivedId(projectId, 'source_plan.pull.record', identity),
            namespace: scope,
            kind: 'approved',
            expectedSelection: null,
            recordBytes,
          },
          { secretAllow, signal: input.signal, onWait: input.onWait }
        )
      );
      approvedKey = { externalId: parsed.external_id, versionNumber: parsed.version_number };
    },
    async writePathPointer(value) {
      if (
        record === null ||
        approvedKey === null ||
        value.externalId !== approvedKey.externalId ||
        value.versionNumber !== approvedKey.versionNumber
      )
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'Publish the exact approved Source Plan before its output path'
        );
      const approved = readProjectApprovedSourcePlan(reader, {
        namespaceId: readNamespace().namespaceId,
        externalId: value.externalId,
        approvedVersion: value.versionNumber,
      });
      if (!approved || approved.selection.recordId !== record.value.selection.recordId)
        throw new ProjectDatabaseError(
          'STALE_CONTEXT',
          'The approved Source Plan selection changed before its output path was recorded'
        );
      let filePath: string;
      try {
        filePath = await realpath(value.realPath);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw cause;
      }
      const scope = readNamespace();
      const current = readProjectSourcePlanLocator(reader, {
        namespaceId: scope.namespaceId,
        kind: 'path',
        realPath: filePath,
      });
      const pointer = {
        real_path: filePath,
        external_id: value.externalId,
        version_number: value.versionNumber,
      };
      const recordBytes = Buffer.from(canonicalJson(pointer) + '\n', 'utf8');
      refusePlanPullPayload({ namespace: scope, pointer }, secretAllow, 'record-and-file');
      const replay =
        current?.record.externalId === value.externalId &&
        current.record.approvedVersion === value.versionNumber &&
        current.record.approvedRecordId === approved.selection.recordId &&
        Buffer.from(current.record.recordBase64, 'base64').equals(recordBytes)
          ? current.record
          : null;
      const identity = {
        target,
        pointer,
        approvedRecordId: approved.selection.recordId,
        expectedSelection: current?.selection ?? null,
      };
      locator = await publish((writer) =>
        publishProjectSourcePlanLocator(
          writer,
          {
            operationId:
              replay?.operationId ?? derivedId(projectId, 'source_plan.path.operation', identity),
            revisionId:
              replay?.revisionId ?? derivedId(projectId, 'source_plan.path.revision', identity),
            namespace: scope,
            kind: 'path',
            realPath: filePath,
            approvedRecordId: approved.selection.recordId,
            expectedSelection: replay ? replay.expectedSelection : (current?.selection ?? null),
            recordBytes,
          },
          { secretAllow, signal: input.signal, onWait: input.onWait }
        )
      );
    },
    state() {
      return structuredClone({ record, locator });
    },
  };
}
