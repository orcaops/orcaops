import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import { expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import {
  compareApprovedSourcePlanRecords,
  type PreparedSourcePlanLocator,
  type PreparedSourcePlanRecord,
  prepareSourcePlanLocator,
  prepareSourcePlanNamespace,
  prepareSourcePlanRecord,
  sourcePlanLocator,
  type SourcePlanNamespace,
  sourcePlanRecord,
  type SourcePlanRecordInput,
} from './source-plan-input.js';

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: vi.fn(() => {
    throw new Error('Unexpected filesystem read');
  }),
  writeFileSync: vi.fn(() => {
    throw new Error('Unexpected filesystem write');
  }),
  mkdirSync: vi.fn(() => {
    throw new Error('Unexpected directory creation');
  }),
  openSync: vi.fn(() => {
    throw new Error('Unexpected filesystem open');
  }),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: vi.fn(() => {
    throw new Error('Unexpected filesystem read');
  }),
  writeFile: vi.fn(() => {
    throw new Error('Unexpected filesystem write');
  }),
  mkdir: vi.fn(() => {
    throw new Error('Unexpected directory creation');
  }),
  open: vi.fn(() => {
    throw new Error('Unexpected filesystem open');
  }),
  realpath: vi.fn(() => {
    throw new Error('Unexpected path resolution');
  }),
}));
function namespace(): Extract<SourcePlanNamespace, { scopeKind: 'account' }> {
  return {
    namespaceId: uuidv7(),
    scopeKind: 'account',
    serverUrl: 'https://example.test',
    orgId: 'original org',
    accountId: 'original account',
    originalNamespaceHash: null,
    originalLocatorHash: null,
  };
}
function approved() {
  const body = 'Retain the exact approved plan.\n';
  return {
    schema_version: 1,
    external_id: 'original:plan/topic with spaces',
    slug: 'original-plan',
    version_number: 3,
    title: 'Original approved plan',
    body,
    content_hash: digest(body),
    source_ref: null,
    base_url: 'https://example.test',
    org_id: 'original org',
    pulled_at: 'original observation time',
  };
}
function input(kind: SourcePlanRecordInput['kind'] = 'approved'): SourcePlanRecordInput {
  const a = approved();
  const value =
    kind === 'approved'
      ? a
      : {
          schema_version: 1,
          target: kind,
          external_id: a.external_id,
          version_id: kind === 'candidate' ? 'opaque:version/with spaces' : null,
          version_number: kind === 'candidate' ? 4 : null,
          proposal_id: kind === 'proposal' ? 'opaque:proposal/with spaces' : null,
          base_version_number: null,
          body: a.body,
          content_hash: a.content_hash,
          base_url: a.base_url,
          org_id: a.org_id,
          pulled_at: a.pulled_at,
        };
  return {
    operationId: uuidv7(),
    recordId: uuidv7(),
    namespace: namespace(),
    kind,
    expectedSelection: null,
    recordBytes: Buffer.from(JSON.stringify(value, null, 2) + '\n'),
  };
}
function changed(raw: SourcePlanRecordInput, values: Record<string, unknown>) {
  return {
    ...raw,
    recordBytes: Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(raw.recordBytes).toString()), ...values })
    ),
  };
}
it.each(['approved', 'candidate', 'proposal'] as const)(
  'preserves exact %s bytes and opaque identity without filesystem work',
  (kind) => {
    const raw = input(kind),
      bytes = Buffer.from(raw.recordBytes);
    const prepared = prepareSourcePlanRecord(raw, []),
      value = sourcePlanRecord(prepared);
    expect(Buffer.from(value.recordBase64, 'base64')).toEqual(bytes);
    expect(value.recordSha256).toBe(digest(bytes));
    expect(value.externalId).toBe('original:plan/topic with spaces');
    expect(value.namespace.accountId).toBe('original account');
    raw.recordBytes.fill(0);
    raw.namespace.orgId = 'changed';
    expect(sourcePlanRecord(prepared)).toEqual(value);
    expect(() => Object.assign(value, { recordBase64: '' })).toThrow();
    expect(value.approvedVersion).toBe(kind === 'approved' ? 3 : null);
    expect(value.versionId).toBe(kind === 'candidate' ? 'opaque:version/with spaces' : null);
    expect(value.proposalId).toBe(kind === 'proposal' ? 'opaque:proposal/with spaces' : null);
    for (const method of [
      fs.readFileSync,
      fs.writeFileSync,
      fs.mkdirSync,
      fs.openSync,
      promises.readFile,
      promises.writeFile,
      promises.mkdir,
      promises.open,
      promises.realpath,
    ])
      expect(method).not.toHaveBeenCalled();
  }
);
it('distinguishes known accounts from historical organization observations', () => {
  const a = namespace(),
    b = { ...a, namespaceId: uuidv7(), accountId: 'another account' };
  const historical: SourcePlanNamespace = {
    ...a,
    namespaceId: uuidv7(),
    scopeKind: 'organization_observation',
    accountId: null,
    originalNamespaceHash: digest(`${a.serverUrl}|${a.orgId}`),
  };
  expect(prepareSourcePlanNamespace(a, [])).not.toEqual(prepareSourcePlanNamespace(b, []));
  expect(prepareSourcePlanNamespace(historical, []).accountId).toBeNull();
  expect(() => prepareSourcePlanRecord({ ...input(), namespace: historical }, [])).toThrow(
    'cannot authorize an authored'
  );
  expect(() =>
    prepareSourcePlanNamespace({ ...historical, originalNamespaceHash: 'a'.repeat(64) }, [])
  ).toThrow('original namespace hash');
});
it('retains unknown upload locators without inventing a server or path', () => {
  const original: SourcePlanNamespace = {
    namespaceId: uuidv7(),
    scopeKind: 'unresolved_upload',
    serverUrl: null,
    orgId: null,
    accountId: null,
    originalNamespaceHash: null,
    originalLocatorHash: 'a'.repeat(64),
  };
  expect(prepareSourcePlanNamespace(original, [])).toEqual(original);
  expect(() => prepareSourcePlanRecord({ ...input(), namespace: original }, [])).toThrow(
    'cannot authorize an authored'
  );
  expect(
    prepareSourcePlanNamespace({ ...original, originalLocatorHash: 'b'.repeat(64) }, [])
  ).not.toEqual(original);
});
it.each([
  'https://user:pass@example.test',
  'https://example.test?next=1',
  'file:///original',
  'https://example.test#other',
])('refuses unsupported server authority %s', (serverUrl) => {
  expect(() => prepareSourcePlanNamespace({ ...namespace(), serverUrl }, [])).toThrow();
});
it.each([
  ['body', 'Changed body'],
  ['content_hash', 'a'.repeat(64)],
  ['org_id', 'another org'],
  ['base_url', 'https://another.test'],
  ['version_number', Number.MAX_SAFE_INTEGER + 1],
])('refuses invalid original %s meaning', (field, value) => {
  expect(() => prepareSourcePlanRecord(changed(input(), { [field]: value }), [])).toThrow();
});
it('refuses mismatched review kinds and malformed original revisions', () => {
  expect(() => prepareSourcePlanRecord({ ...input('candidate'), kind: 'proposal' }, [])).toThrow();
  expect(() =>
    prepareSourcePlanRecord(changed(input('candidate'), { version_id: null }), [])
  ).toThrow();
  expect(() =>
    prepareSourcePlanRecord(changed(input('proposal'), { version_id: 'invented' }), [])
  ).toThrow();
  expect(() =>
    prepareSourcePlanRecord(changed(input('proposal'), { proposal_id: '' }), [])
  ).toThrow();
});
it('detaches exact expected selectors and rejects unsafe or inapplicable versions', () => {
  const raw = input('candidate');
  raw.expectedSelection = { recordId: uuidv7(), version: Number.MAX_SAFE_INTEGER };
  const value = sourcePlanRecord(prepareSourcePlanRecord(raw, []));
  expect(value.expectedSelection).toEqual(raw.expectedSelection);
  raw.expectedSelection.version = 1;
  expect(value.expectedSelection?.version).toBe(Number.MAX_SAFE_INTEGER);
  expect(() =>
    prepareSourcePlanRecord(
      { ...raw, expectedSelection: { recordId: uuidv7(), version: Number.MAX_SAFE_INTEGER + 1 } },
      []
    )
  ).toThrow();
  expect(() =>
    prepareSourcePlanRecord({ ...input(), expectedSelection: raw.expectedSelection }, [])
  ).toThrow();
});
it('permits equal approved re-pull but refuses changed approved facts', () => {
  const raw = input(),
    before = prepareSourcePlanRecord(raw, []);
  const later = {
    ...changed(raw, { pulled_at: 'later original observation' }),
    operationId: uuidv7(),
    recordId: uuidv7(),
  };
  expect(compareApprovedSourcePlanRecords(before, prepareSourcePlanRecord(later, []))).toBe(
    'equal'
  );
  for (const field of ['title', 'slug', 'source_ref'])
    expect(() =>
      compareApprovedSourcePlanRecords(
        before,
        prepareSourcePlanRecord(changed(later, { [field]: 'different' }), [])
      )
    ).toThrow('different retained facts');
  expect(() =>
    compareApprovedSourcePlanRecords(before, prepareSourcePlanRecord(input('candidate'), []))
  ).toThrow();
});
it.each(['raw', 'escaped', 'key'] as const)(
  'refuses %s duplicate lexical secrets before parsing can discard them',
  (mode) => {
    const token = 'ghp_' + 'A'.repeat(36),
      a = approved();
    const hidden = mode === 'escaped' ? token.slice(0, 8) + '\0' + token.slice(8) : token;
    const key = mode === 'key' ? JSON.stringify(token) : '"body"';
    const bytes = Buffer.from(`{${key}:${JSON.stringify(hidden)},${JSON.stringify(a).slice(1)}`);
    expect(() => prepareSourcePlanRecord({ ...input(), recordBytes: bytes }, [])).toThrow(
      'Secret refusal'
    );
  }
);
it('preserves established known-dead allowances without an approved body bypass', () => {
  const token = 'ghp_' + 'A'.repeat(36),
    raw = changed(input(), { body: token, content_hash: digest(token) });
  expect(() => prepareSourcePlanRecord(raw, [])).toThrow('Secret refusal');
  expect(sourcePlanRecord(prepareSourcePlanRecord(raw, [token])).contentHash).toBe(digest(token));
});
it.each(['path', 'upload'] as const)(
  'preserves exact %s locator bytes and original path',
  (kind) => {
    const value =
      kind === 'path'
        ? {
            real_path: '/original/path with spaces',
            external_id: 'original:plan',
            version_number: 3,
          }
        : {
            fingerprint: 'b'.repeat(64),
            external_id: 'original:plan',
            unresolved: ['Zed', 'Ada', 'Zed'],
          };
    const raw = {
      operationId: uuidv7(),
      revisionId: uuidv7(),
      namespace: namespace(),
      kind,
      realPath: '/original/path with spaces',
      approvedRecordId: kind === 'path' ? uuidv7() : null,
      expectedSelection: null,
      recordBytes: Buffer.from(JSON.stringify(value, null, 2)),
    };
    const retained = sourcePlanLocator(prepareSourcePlanLocator(raw, []));
    expect(Buffer.from(retained.recordBase64, 'base64')).toEqual(raw.recordBytes);
    expect(retained.pathHash).toBe(digest(raw.realPath));
    raw.realPath = '/changed';
    raw.recordBytes.fill(0);
    expect(retained.realPath).toBe('/original/path with spaces');
    if (kind === 'upload')
      expect(
        JSON.parse(Buffer.from(retained.recordBase64, 'base64').toString()).unresolved
      ).toEqual(['Zed', 'Ada', 'Zed']);
    expect(() =>
      prepareSourcePlanLocator(
        { ...raw, recordBytes: Buffer.from(JSON.stringify(value)), realPath: 'relative/path' },
        []
      )
    ).toThrow();
  }
);
it('refuses unbound paths and upload claims of approval', () => {
  const raw = {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    namespace: namespace(),
    kind: 'path' as const,
    realPath: '/original',
    approvedRecordId: null,
    expectedSelection: null,
    recordBytes: Buffer.from(
      JSON.stringify({ real_path: '/original', external_id: 'plan', version_number: 1 })
    ),
  };
  expect(() => prepareSourcePlanLocator(raw, [])).toThrow();
  expect(() =>
    prepareSourcePlanLocator({ ...raw, approvedRecordId: uuidv7(), realPath: '/other' }, [])
  ).toThrow();
  expect(() =>
    prepareSourcePlanLocator(
      {
        ...raw,
        kind: 'upload',
        approvedRecordId: uuidv7(),
        recordBytes: Buffer.from(
          JSON.stringify({ fingerprint: 'a'.repeat(64), external_id: 'plan', unresolved: [] })
        ),
      },
      []
    )
  ).toThrow();
});
it('refuses forged prepared handles', () => {
  expect(() =>
    sourcePlanRecord({ kind: 'prepared-source-plan-record' } as PreparedSourcePlanRecord)
  ).toThrow();
  expect(() =>
    sourcePlanLocator({ kind: 'prepared-source-plan-locator' } as PreparedSourcePlanLocator)
  ).toThrow();
});
