import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { canonicalJson } from '../../events/canonical-json.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import {
  prepareSourcePlanLocator,
  prepareSourcePlanNamespace,
  prepareSourcePlanRecord,
  sourcePlanLocator,
  type SourcePlanNamespace,
  sourcePlanRecord,
} from './source-plan-input.js';
import * as inputs from './source-plan-input.js';
import {
  readProjectApprovedSourcePlan,
  readProjectSourcePlanLocator,
  readProjectSourcePlanReview,
  scanProjectApprovedSourcePlans,
} from './source-plan-reader.js';
import { sourcePlanLocatorReceipt, sourcePlanRecordReceipt } from './source-plan-records.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
const databases: Database.Database[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
  handles.splice(0).forEach((h) => h.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'source-plan-read-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const file = projectDatabasePath(authority);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-09-01T00:00:00Z',
    authorize() {},
  });
  handles.push(handle);
  const db = new Database(file);
  databases.push(db);
  db.pragma('foreign_keys=ON');
  return { db, handle };
}
function corrupt(db: Database.Database, trigger: string, sql: string, ...args: unknown[]) {
  const row = db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(trigger) as {
    sql: string;
  };
  db.pragma('foreign_keys=OFF');
  db.exec(`DROP TRIGGER ${trigger}`);
  try {
    db.prepare(sql).run(...args);
  } finally {
    db.exec(row.sql);
    db.pragma('foreign_keys=ON');
  }
}
function put(db: Database.Database, table: string, row: Record<string, unknown>) {
  return db
    .prepare(
      `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
        .map(() => '?')
        .join(',')})`
    )
    .run(...Object.values(row));
}
function namespace(db: Database.Database, accountId = 'original account') {
  const value = prepareSourcePlanNamespace(
    {
      namespaceId: uuidv7(),
      scopeKind: 'account',
      serverUrl: 'https://example.test',
      orgId: 'original org',
      accountId,
      originalNamespaceHash: null,
      originalLocatorHash: null,
    },
    []
  );
  put(db, 'source_plan_namespaces', {
    namespace_id: value.namespaceId,
    scope_kind: value.scopeKind,
    server_url: value.serverUrl,
    org_id: value.orgId,
    account_id: value.accountId,
    original_namespace_hash: value.originalNamespaceHash,
    original_locator_hash: value.originalLocatorHash,
  });
  return value;
}
function operation(_db: Database.Database) {
  return uuidv7();
}
function receipt(
  db: Database.Database,
  operationId: string,
  kind: string,
  descriptor: { target: unknown; payload: unknown; expectedState: unknown },
  result: unknown
) {
  const payload = canonicalJson(descriptor.payload);
  db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    operationId,
    kind,
    0,
    canonicalJson(descriptor.target),
    payload,
    digest(payload),
    canonicalJson(descriptor.expectedState),
    canonicalJson(result),
    1,
    0
  );
}

function record(
  db: Database.Database,
  kind: 'approved' | 'candidate' | 'proposal' = 'approved',
  ns = namespace(db),
  externalId = 'original:plan',
  body = 'Original Source Plan body\n',
  allow: string[] = []
) {
  const common = {
    schema_version: 1,
    external_id: externalId,
    body,
    content_hash: digest(body),
    base_url: ns.serverUrl,
    org_id: ns.orgId,
    pulled_at: 'original time',
  };
  const value =
    kind === 'approved'
      ? { ...common, slug: 'original', version_number: 3, title: 'Original plan', source_ref: null }
      : {
          ...common,
          target: kind,
          version_id: kind === 'candidate' ? 'opaque:revision' : null,
          version_number: kind === 'candidate' ? 4 : null,
          proposal_id: kind === 'proposal' ? 'opaque:proposal' : null,
          base_version_number: null,
        };
  const prepared = prepareSourcePlanRecord(
    {
      operationId: operation(db),
      recordId: uuidv7(),
      namespace: ns,
      kind,
      expectedSelection: null,
      recordBytes: Buffer.from(JSON.stringify(value, null, 2)),
    },
    allow
  );
  const r = sourcePlanRecord(prepared);
  const row = {
    record_id: r.recordId,
    namespace_id: r.namespace.namespaceId,
    kind: r.kind,
    original_record_id: null,
    record_bytes: Buffer.from(r.recordBase64, 'base64'),
    publication_operation_id: r.operationId,
    import_provenance_id: null,
    record_sha256: r.recordSha256,
    external_id: r.externalId,
    approved_version: r.approvedVersion,
    version_id: r.versionId,
    version_number: r.versionNumber,
    proposal_id: r.proposalId,
    base_version_number: r.baseVersionNumber,
    content_hash: r.contentHash,
    pulled_at: r.pulledAt,
  };
  receipt(db, r.operationId, 'source_plan.record', sourcePlanRecordReceipt(r), {
    recordId: r.recordId,
    selection: { recordId: r.recordId, version: 1 },
  });
  put(db, 'source_plan_records', row);
  return { row, namespace: ns, prepared };
}
function approved(db: Database.Database, ns?: SourcePlanNamespace) {
  const result = record(db, 'approved', ns);
  const { row } = result;
  put(db, 'source_plan_approved', {
    namespace_id: row.namespace_id,
    external_id: row.external_id,
    approved_version: row.approved_version,
    record_id: row.record_id,
  });
  return result;
}
function review(db: Database.Database, kind: 'candidate' | 'proposal' = 'candidate') {
  const result = record(db, kind);
  const row = {
    namespace_id: result.row.namespace_id,
    kind,
    subject_id: kind === 'candidate' ? result.row.external_id : result.row.proposal_id,
    record_id: result.row.record_id,
    version: 1,
  };
  put(db, 'source_plan_review_current', row);
  return { ...result, selection: row };
}
function locator(
  db: Database.Database,
  kind: 'path' | 'upload' = 'path',
  selected = true,
  source = approved(db)
) {
  const value =
    kind === 'path'
      ? { real_path: '/original/plan.md', external_id: source.row.external_id, version_number: 3 }
      : {
          fingerprint: 'b'.repeat(64),
          external_id: source.row.external_id,
          unresolved: ['Ada', 'Zed'],
        };
  const prepared = prepareSourcePlanLocator(
    {
      operationId: operation(db),
      revisionId: uuidv7(),
      namespace: source.namespace,
      kind,
      realPath: '/original/plan.md',
      approvedRecordId: kind === 'path' ? source.row.record_id : null,
      expectedSelection: null,
      recordBytes: Buffer.from(JSON.stringify(value, null, 2)),
    },
    []
  );
  const r = sourcePlanLocator(prepared);
  const row = {
    revision_id: r.revisionId,
    namespace_id: r.namespace.namespaceId,
    kind: r.kind,
    record_bytes: Buffer.from(r.recordBase64, 'base64'),
    original_record_id: null,
    publication_operation_id: r.operationId,
    import_provenance_id: null,
    approved_record_id: r.approvedRecordId,
    record_sha256: r.recordSha256,
    real_path: r.realPath,
    path_hash: r.pathHash,
    original_locator_hash: null,
    external_id: r.externalId,
    approved_version: r.approvedVersion,
    fingerprint: r.fingerprint,
  };
  receipt(db, r.operationId, 'source_plan.locator', sourcePlanLocatorReceipt(r), {
    revisionId: r.revisionId,
    selection: { recordId: r.revisionId, version: 1 },
  });
  put(db, 'source_plan_locator_revisions', row);
  const current = {
    namespace_id: row.namespace_id,
    kind,
    locator_kind: 'real_path',
    locator: r.realPath,
    revision_id: r.revisionId,
    version: 1,
  };
  if (selected) put(db, 'source_plan_locator_current', current);
  return { row, selection: current, source };
}

it('reads exact approved bytes with one genuine read claim and decodes after release', async () => {
  const { db, handle } = await fixture();
  const source = approved(db);
  const before = db.serialize();
  const decode = inputs.decodeRetainedSourcePlanRecord;
  vi.spyOn(inputs, 'decodeRetainedSourcePlanRecord').mockImplementation((input) => {
    expect(handle.read(() => null).value).toBeNull();
    return decode(input);
  });
  const result = readProjectApprovedSourcePlan(handle, {
    namespaceId: source.row.namespace_id,
    externalId: source.row.external_id,
    approvedVersion: 3,
  })!;
  expect(result.record.recordBase64).toBe(sourcePlanRecord(source.prepared).recordBase64);
  expect(result.selection).toEqual({ recordId: source.row.record_id, version: 1 });
  expect(db.serialize().equals(before)).toBe(true);
});
it('scans one approved version across exact account namespaces', async () => {
  const { db, handle } = await fixture();
  const accountA = approved(db, namespace(db, 'account-a'));
  const accountB = approved(db, namespace(db, 'account-b'));
  const result = scanProjectApprovedSourcePlans(handle, {
    externalId: accountA.row.external_id,
    approvedVersion: 3,
  });
  expect(result.matches.map(({ record }) => record.namespace.accountId).sort()).toEqual([
    'account-a',
    'account-b',
  ]);
  expect(result.matches.map(({ record }) => record.recordBase64).sort()).toEqual(
    [accountA, accountB].map(({ prepared }) => sourcePlanRecord(prepared).recordBase64).sort()
  );
});
it.each(['candidate', 'proposal'] as const)(
  'selects the exact %s subject without certifying approval',
  async (kind) => {
    const { db, handle } = await fixture();
    const source = review(db, kind);
    const result = readProjectSourcePlanReview(handle, {
      namespaceId: source.row.namespace_id,
      kind,
      subjectId: source.selection.subject_id!,
    });
    expect(result?.record.recordBase64).toBe(sourcePlanRecord(source.prepared).recordBase64);
    expect(
      readProjectApprovedSourcePlan(handle, {
        namespaceId: source.row.namespace_id,
        externalId: source.row.external_id,
        approvedVersion: 3,
      })
    ).toBeNull();
  }
);
it.each(['path', 'upload'] as const)('reads exact %s locator ownership', async (kind) => {
  const { db, handle } = await fixture();
  const source = locator(db, kind);
  const result = readProjectSourcePlanLocator(handle, {
    namespaceId: source.row.namespace_id,
    kind,
    realPath: source.row.real_path,
  });
  expect(result?.record.recordSha256).toBe(source.row.record_sha256);
  expect(result?.selection).toEqual({ recordId: source.row.revision_id, version: 1 });
});
it('guards every reader before invoking a supplied handle method', () => {
  const read = vi.fn(() => {
    throw Error('forged read');
  });
  const fake = { read } as unknown as ProjectDatabase;
  const namespaceId = uuidv7();
  for (const run of [
    () =>
      readProjectApprovedSourcePlan(fake, { namespaceId, externalId: 'plan', approvedVersion: 1 }),
    () => scanProjectApprovedSourcePlans(fake, { externalId: 'plan', approvedVersion: 1 }),
    () => readProjectSourcePlanReview(fake, { namespaceId, kind: 'candidate', subjectId: 'plan' }),
    () => readProjectSourcePlanLocator(fake, { namespaceId, kind: 'path', realPath: '/plan' }),
  ])
    expect(run).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(read).not.toHaveBeenCalled();
});
it.each(['approved', 'candidate', 'proposal'] as const)(
  'refuses a missing %s selector while original rows remain',
  async (kind) => {
    const { db, handle } = await fixture();
    const source = kind === 'approved' ? approved(db) : review(db, kind);
    const table = kind === 'approved' ? 'source_plan_approved' : 'source_plan_review_current';
    corrupt(
      db,
      kind === 'approved' ? 'source_plan_approved_no_delete' : 'source_plan_review_no_delete',
      `DELETE FROM ${table}`
    );
    const before = db.serialize();
    const run =
      kind === 'approved'
        ? () =>
            readProjectApprovedSourcePlan(handle, {
              namespaceId: source.row.namespace_id,
              externalId: source.row.external_id,
              approvedVersion: 3,
            })
        : () =>
            readProjectSourcePlanReview(handle, {
              namespaceId: source.row.namespace_id,
              kind,
              subjectId: kind === 'candidate' ? source.row.external_id : source.row.proposal_id!,
            });
    expect(run).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
    expect(db.serialize().equals(before)).toBe(true);
    expect(handle.read(() => null).value).toBeNull();
  }
);
it('refuses missing locator selection and preserves original revision bytes', async () => {
  const { db, handle } = await fixture();
  const source = locator(db, 'upload', false);
  const before = db.serialize();
  expect(() =>
    readProjectSourcePlanLocator(handle, {
      namespaceId: source.row.namespace_id,
      kind: 'upload',
      realPath: source.row.real_path,
    })
  ).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
  expect(db.serialize().equals(before)).toBe(true);
});
it.each(['record_sha256', 'external_id', 'content_hash', 'pulled_at'] as const)(
  'refuses inconsistent normalized %s without repairing it',
  async (column) => {
    const { db, handle } = await fixture();
    const source = approved(db);
    corrupt(
      db,
      'source_plan_records_no_update',
      `UPDATE source_plan_records SET ${column}=? WHERE record_id=?`,
      column.includes('hash') || column.includes('sha') ? 'b'.repeat(64) : 'different',
      source.row.record_id
    );
    const before = db.serialize();
    expect(() =>
      readProjectApprovedSourcePlan(handle, {
        namespaceId: source.row.namespace_id,
        externalId: source.row.external_id,
        approvedVersion: 3,
      })
    ).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
    expect(db.serialize().equals(before)).toBe(true);
  }
);
it('does not reapply current authored refusal to original accepted bytes', async () => {
  const { db, handle } = await fixture();
  const source = approved(db);
  vi.spyOn(inputs, 'prepareSourcePlanRecord').mockImplementation(() => {
    throw Error('authored preparation invoked');
  });
  expect(
    readProjectApprovedSourcePlan(handle, {
      namespaceId: source.row.namespace_id,
      externalId: source.row.external_id,
      approvedVersion: 3,
    })?.record.recordId
  ).toBe(source.row.record_id);
});

it('preserves a previously allowed original body without a new allowlist', async () => {
  const { db, handle } = await fixture();
  const token = 'ghp_' + 'A'.repeat(36);
  const source = record(db, 'approved', namespace(db), 'original:plan', token, [token]);
  put(db, 'source_plan_approved', {
    namespace_id: source.row.namespace_id,
    external_id: source.row.external_id,
    approved_version: 3,
    record_id: source.row.record_id,
  });
  const original = sourcePlanRecord(source.prepared);
  expect(() =>
    prepareSourcePlanRecord(
      {
        operationId: original.operationId,
        recordId: original.recordId,
        namespace: original.namespace,
        kind: original.kind,
        expectedSelection: original.expectedSelection,
        recordBytes: source.row.record_bytes,
      },
      []
    )
  ).toThrow(expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' }));
  const before = db.serialize();
  expect(
    readProjectApprovedSourcePlan(handle, {
      namespaceId: source.row.namespace_id,
      externalId: source.row.external_id,
      approvedVersion: 3,
    })?.record.recordBase64
  ).toBe(source.row.record_bytes.toString('base64'));
  expect(db.serialize().equals(before)).toBe(true);
});
it.each(['operation_kind', 'result_json', 'payload_hash'] as const)(
  'refuses inconsistent original receipt %s',
  async (column) => {
    const { db, handle } = await fixture();
    const source = approved(db);
    corrupt(
      db,
      'operations_no_update',
      `UPDATE operations SET ${column}=? WHERE operation_id=?`,
      column === 'payload_hash'
        ? 'b'.repeat(64)
        : column === 'result_json'
          ? '{}'
          : 'unrelated.domain',
      source.row.publication_operation_id
    );
    expect(() =>
      readProjectApprovedSourcePlan(handle, {
        namespaceId: source.row.namespace_id,
        externalId: source.row.external_id,
        approvedVersion: 3,
      })
    ).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
  }
);

it('refuses a changed namespace spelling instead of normalizing retained authority', async () => {
  const { db, handle } = await fixture();
  const source = approved(db);
  corrupt(
    db,
    'source_plan_namespaces_no_update',
    'UPDATE source_plan_namespaces SET server_url=? WHERE namespace_id=?',
    'https://example.test/',
    source.row.namespace_id
  );
  expect(() =>
    readProjectApprovedSourcePlan(handle, {
      namespaceId: source.row.namespace_id,
      externalId: source.row.external_id,
      approvedVersion: 3,
    })
  ).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
});
