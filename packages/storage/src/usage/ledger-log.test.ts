import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendUsageLedgerRecord, readUsageLedger, type UsageLedgerPaths } from './ledger-log.js';
import { uuidv7 } from '../ids/uuidv7.js';
import { PathContainmentError } from '../paths/containment.js';

let tmp: string;
let paths: UsageLedgerPaths;
const SOURCE_PLAN_PAYLOAD = {
  canonical_ref_id: 'plan-ref',
  artifact_id: '01999999-9999-7000-8000-000000000001',
  linked_at: '2026-01-01T00:00:00.000Z',
  pinned_version: null,
};
const AGENT_USAGE_PAYLOAD = {
  snapshot_id: 'snapshot-1',
  idempotency_key: 'usage-1',
  agent: 'claude-code',
  session_id: 'session-1',
  artifact_id: null,
  source_plan_ref_id: null,
  lifecycle_event: 'plan_review',
  checkpoint_n: null,
  cumulative_usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  delta_usage: null,
  baseline_kind: 'first_observation',
  model_breakdown: [],
  record_count: 1,
  as_of: '2026-01-01T00:00:00.000Z',
};

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'orcaops-ledger-log-'));
  paths = { ledgerPath: path.join(tmp, 'ledger.ndjson'), sidecarsDir: path.join(tmp, 'sidecars') };
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('usage ledger log', () => {
  it('round-trips an inline record with its payload', async () => {
    await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-01-01T00:00:00.000Z',
        idempotency_key: 'k',
        payload: SOURCE_PLAN_PAYLOAD,
      },
      paths
    );
    const events = await readUsageLedger(paths);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('source_plan_linked');
    expect(events[0].idempotency_key).toBe('k');
    expect(events[0].payload).toEqual(SOURCE_PLAN_PAYLOAD);
  });

  it('spills a payload over 8 KB to a sidecar and reads it back', async () => {
    const big = { ...AGENT_USAGE_PAYLOAD, session_id: 'x'.repeat(9000) };
    await appendUsageLedgerRecord(
      {
        type: 'agent_usage_snapshot_recorded',
        ts: '2026-01-01T00:00:00.000Z',
        idempotency_key: AGENT_USAGE_PAYLOAD.idempotency_key,
        payload: big,
      },
      paths
    );
    const sidecars = await readdir(paths.sidecarsDir);
    expect(sidecars).toHaveLength(1);
    const events = await readUsageLedger(paths);
    expect(events[0].payload).toEqual(big);
  });

  it('skips a checksum-tampered line', async () => {
    await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-01-01T00:00:00.000Z',
        idempotency_key: 'k',
        payload: SOURCE_PLAN_PAYLOAD,
      },
      paths
    );
    const rec = JSON.parse((await readFile(paths.ledgerPath, 'utf8')).trim());
    rec.payload = { ...SOURCE_PLAN_PAYLOAD, canonical_ref_id: 'tampered' };
    await writeFile(paths.ledgerPath, JSON.stringify(rec) + '\n', 'utf8');
    expect(await readUsageLedger(paths)).toHaveLength(0);
  });

  it('counts type-invalid payloads as invalid records', async () => {
    await appendUsageLedgerRecord(
      {
        type: 'agent_usage_snapshot_recorded',
        ts: '2026-01-01T00:00:00.000Z',
        idempotency_key: 'bad-snapshot',
        payload: { malformed: true },
      },
      paths
    );
    await appendUsageLedgerRecord(
      {
        type: 'source_plan_linked',
        ts: '2026-01-01T00:00:01.000Z',
        idempotency_key: 'bad-link',
        payload: { malformed: true },
      },
      paths
    );
    let invalidRecords = 0;

    const events = await readUsageLedger({
      ...paths,
      onInvalidRecord: () => {
        invalidRecords += 1;
      },
    });

    expect(events).toEqual([]);
    expect(invalidRecords).toBe(2);
  });

  it('rejects a snapshot whose payload and envelope idempotency keys disagree', async () => {
    await appendUsageLedgerRecord(
      {
        type: 'agent_usage_snapshot_recorded',
        ts: '2026-01-01T00:00:00.000Z',
        idempotency_key: 'envelope-key',
        payload: AGENT_USAGE_PAYLOAD,
      },
      paths
    );
    let invalidRecords = 0;

    const events = await readUsageLedger({
      ...paths,
      onInvalidRecord: () => {
        invalidRecords += 1;
      },
    });

    expect(events).toEqual([]);
    expect(invalidRecords).toBe(1);
  });

  it('returns [] for a missing ledger file', async () => {
    expect(
      await readUsageLedger({
        ledgerPath: path.join(tmp, 'nope.ndjson'),
        sidecarsDir: paths.sidecarsDir,
      })
    ).toEqual([]);
  });

  it('refuses a repository usage-directory redirect before writing', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'orcaops-ledger-outside-'));
    const usageDir = path.join(tmp, '.orcaops', 'usage');
    await mkdir(path.dirname(usageDir), { recursive: true });
    await symlink(outside, usageDir);
    const containedPaths = {
      ledgerPath: path.join(usageDir, 'ledger.ndjson'),
      sidecarsDir: path.join(usageDir, 'sidecars'),
      containmentRoot: tmp,
    };
    try {
      await expect(
        appendUsageLedgerRecord(
          {
            type: 'source_plan_linked',
            ts: '2026-01-01T00:00:00.000Z',
            idempotency_key: 'contained',
            payload: { a: 1 },
          },
          containedPaths
        )
      ).rejects.toThrow(/must not contain symlinks/);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a final ledger symlink before reading its target', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'orcaops-ledger-outside-'));
    try {
      const containedPaths = {
        ledgerPath: path.join(tmp, 'managed', 'ledger.ndjson'),
        sidecarsDir: path.join(tmp, 'managed', 'sidecars'),
        containmentRoot: tmp,
      };
      await appendUsageLedgerRecord(
        {
          type: 'source_plan_linked',
          ts: '2026-01-01T00:00:00.000Z',
          idempotency_key: 'linked',
          payload: { a: 1 },
        },
        containedPaths
      );
      const externalLedger = path.join(outside, 'ledger.ndjson');
      await writeFile(externalLedger, await readFile(containedPaths.ledgerPath));
      await unlink(containedPaths.ledgerPath);
      await symlink(externalLedger, containedPaths.ledgerPath);

      await expect(readUsageLedger(containedPaths)).rejects.toBeInstanceOf(PathContainmentError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('ledger record ID validation', () => {
  const BASE = {
    type: 'source_plan_linked' as const,
    ts: '2026-01-01T00:00:00.000Z',
    idempotency_key: 'id-k',
    payload: SOURCE_PLAN_PAYLOAD,
  };

  it('refuses a traversing event_id override at the write ingress', async () => {
    await expect(
      appendUsageLedgerRecord({ ...BASE, event_id: '../../victim' }, paths)
    ).rejects.toThrow(/not a canonical UUIDv7/);
  });

  it('accepts a caller-minted UUIDv7 override', async () => {
    const id = uuidv7();
    await appendUsageLedgerRecord({ ...BASE, event_id: id }, paths);
    const events = await readUsageLedger(paths);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_id).toBe(id);
  });

  it('skips a stored record whose event_id is not a UUIDv7 at read', async () => {
    await appendUsageLedgerRecord(BASE, paths);
    const raw = await readFile(paths.ledgerPath, 'utf8');
    const eventId = (JSON.parse(raw.trim()) as { event_id: string }).event_id;
    await writeFile(paths.ledgerPath, raw.replace(eventId, '../../escape'), 'utf8');
    const events = await readUsageLedger(paths);
    expect(events).toEqual([]);
  });
});
