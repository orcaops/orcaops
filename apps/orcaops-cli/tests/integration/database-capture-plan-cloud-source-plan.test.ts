import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SourcePlanApprovedPull } from '@orcaops/sdk';
import { canonicalizeBaseUrl, sha256Hex } from '@orcaops/storage';
import {
  listProjectArtifacts,
  readProjectApprovedSourcePlan,
  readProjectArtifact,
  readProjectSourcePlanLocator,
  readProjectSourcePlanNamespace,
} from '@orcaops/storage/history/database';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';
import { inputFile } from '@orcaops/test-harness';

import { fixture, git } from '../helpers/database-history.js';
import { cloudRecord } from '../support/source-plan-test-helpers.js';
import { makeAgent } from '../support/test-agent.js';

const seams = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock('@orcaops/core/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@orcaops/core/history')>()),
  createCanonicalCloudClient: seams.connect,
}));

type Fixture = Awaited<ReturnType<typeof fixture>>;
const SESSION = 'cloud-source-plan-session';
const target: RemoteTarget = {
  server_url: 'https://cloud.example',
  org_id: 'org_1',
  account_id: 'account-a',
};

function approved(): SourcePlanApprovedPull {
  const record = cloudRecord();
  return {
    externalId: record.external_id,
    slug: record.slug,
    title: record.title,
    approvedVersion: {
      versionNumber: record.version_number,
      body: record.body,
      contentHash: record.content_hash,
      sourceRef: record.source_ref,
    },
  };
}

function connectAs(selectedTarget: RemoteTarget) {
  seams.connect.mockResolvedValue({
    client: {
      sourcePlan: {
        getApproved: vi.fn(async () => approved()),
        get: vi.fn(),
      },
    },
    target: selectedTarget,
    credentialStore: {},
  });
}

function agent(repository: { main: string; root: string; temporary: string }) {
  return makeAgent({
    cwd: repository.main,
    cloudBaseUrl: target.server_url,
    env: {
      ORCAOPS_ROOT: repository.main,
      ORCAOPS_DATA_DIR: repository.root,
      ORCAOPS_CLOUD_FEATURES: '1',
      ORCAOPS_DISABLE_DRAIN: '1',
      CODEX_SESSION_ID: SESSION,
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      TMUX_PANE: '',
      STY: '',
      WINDOW: '',
      TTY: '',
      XDG_STATE_HOME: path.join(repository.temporary, 'unused-state'),
    },
  });
}

function payload() {
  return {
    idempotency_key: `plan-${randomUUID()}`,
    task: 'Pin an approved cloud plan',
    label: 'Cloud pin',
    plan_steps: [{ text: 'do it', label: 'Do' }],
    touched_scope: ['cli'],
  };
}

async function capturePlan(f: { main: string; root: string; temporary: string }, ref: string) {
  const raw = await agent(f).runRaw([
    'capture',
    'plan',
    '--no-llm',
    '--input',
    inputFile(JSON.stringify(payload())),
    '--source-plan',
    ref,
  ]);
  return { raw, result: JSON.parse(raw.stdout) };
}

async function pull(f: Fixture, out = 'approved.md') {
  const raw = await agent(f).runRaw(['plan', 'pull', 'source-plan', '--out', out, '--json']);
  expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
  return JSON.parse(raw.stdout) as {
    external_id: string;
    version_number: number;
    ref: string;
    out: string;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connectAs(target);
});

describe('registered database capture plan — cloud source plan', { timeout: 60_000 }, () => {
  it('pins the exact approved record offline after pull and preserves its output locator', async () => {
    const f = await fixture();
    const pulled = await pull(f);
    const namespace = readProjectSourcePlanNamespace(f.writer, {
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
    })!;
    const selected = readProjectApprovedSourcePlan(f.writer, {
      namespaceId: namespace.namespaceId,
      externalId: pulled.external_id,
      approvedVersion: pulled.version_number,
    })!;
    const locator = readProjectSourcePlanLocator(f.writer, {
      namespaceId: namespace.namespaceId,
      kind: 'path',
      realPath: pulled.out,
    })!;
    const cloudCalls = seams.connect.mock.calls.length;

    const { raw, result } = await capturePlan(f, pulled.ref);

    expect(raw.exitCode, raw.stdout + raw.stderr).toBe(0);
    expect(seams.connect).toHaveBeenCalledTimes(cloudCalls);
    expect(result.source_plan).toEqual({
      pinned: true,
      source_ref: {
        kind: 'cloud',
        locator: pulled.external_id,
        version: String(pulled.version_number),
        base_url: target.server_url,
        org_id: target.org_id,
      },
      hash: approved().approvedVersion.contentHash,
    });
    const retained = readProjectArtifact(f.writer, result.artifact_id as string)!;
    expect(retained.thread.artifactJson?.source_plan).toMatchObject({
      content: approved().approvedVersion.body,
      hash: selected.record.contentHash,
      source_ref: { version: String(selected.record.approvedVersion) },
    });
    expect(
      readProjectSourcePlanLocator(f.writer, {
        namespaceId: namespace.namespaceId,
        kind: 'path',
        realPath: pulled.out,
      })
    ).toMatchObject({
      selection: locator.selection,
      record: { approvedRecordId: selected.selection.recordId },
    });
  });

  it('refuses the same approved identity retained under two account namespaces', async () => {
    const f = await fixture();
    const first = await pull(f);
    connectAs({ ...target, account_id: 'account-b' });
    await pull(f, 'other-account.md');
    const before = listProjectArtifacts(f.writer, { limit: 100, offset: 0 });
    const cloudCalls = seams.connect.mock.calls.length;

    const { raw, result } = await capturePlan(f, first.ref);

    expect(raw.exitCode).toBe(1);
    expect(result).toMatchObject({ ok: false, error: { code: 'NO_INPUT' } });
    expect(result.error.message).toMatch(/multiple account namespaces/);
    expect(seams.connect).toHaveBeenCalledTimes(cloudCalls);
    expect(listProjectArtifacts(f.writer, { limit: 100, offset: 0 })).toEqual(before);
  });

  it('does not fall back to a legacy pull-cache record', async () => {
    const f = await fixture();
    const record = cloudRecord();
    const legacyPath = path.join(
      f.main,
      '.orcaops',
      'cache',
      'source-plan',
      'pull',
      sha256Hex(`${canonicalizeBaseUrl(record.base_url)}|${record.org_id}`),
      'by-id',
      `${sha256Hex(record.external_id)}@${record.version_number}.json`
    );
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify(record));
    const { raw, result } = await capturePlan(f, 'cloud:ext-1@3');
    expect(raw.exitCode).toBe(1);
    expect(result).toMatchObject({ ok: false, error: { code: 'NO_INPUT' } });
    expect(result.error.message).toMatch(/plan pull/);
    expect(listProjectArtifacts(f.writer, { limit: 100, offset: 0 }).artifacts).toEqual([]);
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it('refuses a secret cloud reference before initializing fresh history', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'database-cloud-pin-'));
    try {
      const main = path.join(temporary, 'main');
      const root = path.join(temporary, 'data');
      await mkdir(main);
      await git(main, ['init', '-qb', 'main']);
      await git(main, ['commit', '--allow-empty', '-qm', 'Initial']);
      const secret = 'ghp_' + 'A'.repeat(36);

      const { raw, result } = await capturePlan({ main, root, temporary }, `cloud:${secret}@1`);

      expect(raw.exitCode).toBe(1);
      expect(result).toMatchObject({ ok: false, error: { code: 'SECRET_IN_PAYLOAD' } });
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(seams.connect).not.toHaveBeenCalled();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
