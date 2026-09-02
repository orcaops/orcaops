import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeArtifactJson } from './artifact-json.js';
import {
  type ArtifactJson,
  ArtifactJsonSchema,
  type BranchLineageEntry,
} from '../schema/artifact-json.js';

describe('artifact.json schema', () => {
  function validInput(over: Partial<ArtifactJson> = {}): ArtifactJson {
    const lineageEntry: BranchLineageEntry = {
      branch: 'feat/auth',
      head_sha: 'abc1234',
      ts: '2026-04-26T12:00:00.000Z',
      event: 'created',
    };
    return {
      schema_version: 1,
      id: '01J9XR8M7K2QFGKW8',
      state: 'planned',
      branch_lineage: [lineageEntry],
      created_by_session_id: 'sess_xyz',
      created_at: '2026-04-26T12:00:00.000Z',
      updated_at: '2026-04-26T12:00:00.000Z',
      checkpoint_count: 0,
      plan_revision_count: 0,
      plan_last_revised_at: null,
      source_event_id: 'evt_plan',
      source_plan: null,
      pre_pr_checked_head_sha: null,
      pre_pr_checked_source_event_id: null,
      baseline_seed_tree_sha: null,
      superseded_artifact_id: null,
      ...over,
    };
  }

  it('accepts a minimal event-backed projection', () => {
    const parsed = ArtifactJsonSchema.parse(validInput());
    expect(parsed.state).toBe('planned');
    expect(parsed.checkpoint_count).toBe(0);
    expect(parsed.source_event_id).toBe('evt_plan');
    expect(parsed.branch_lineage).toHaveLength(1);
  });

  it('accepts a fully-populated projection (active, sourced from event)', () => {
    const parsed = ArtifactJsonSchema.parse(
      validInput({
        state: 'active',
        checkpoint_count: 3,
        source_event_id: 'evt_01J9XS',
        branch_lineage: [
          {
            branch: 'feat/auth',
            head_sha: 'abc1234',
            ts: '2026-04-26T12:00:00.000Z',
            event: 'created',
          },
          {
            branch: 'feat/auth',
            head_sha: 'def5678',
            ts: '2026-04-26T13:00:00.000Z',
            event: 'rebased',
          },
        ],
      })
    );
    expect(parsed.state).toBe('active');
    expect(parsed.branch_lineage).toHaveLength(2);
    expect(parsed.branch_lineage[1].event).toBe('rebased');
  });

  it('accepts created_by_session_id=null (headless / no env var available)', () => {
    const parsed = ArtifactJsonSchema.parse(validInput({ created_by_session_id: null }));
    expect(parsed.created_by_session_id).toBeNull();
  });

  it('rejects branch_lineage=[] — every artifact carries at least one entry', () => {
    expect(() => ArtifactJsonSchema.parse(validInput({ branch_lineage: [] }))).toThrow();
  });

  it('rejects an unknown state', () => {
    expect(() =>
      ArtifactJsonSchema.parse(
        validInput({ state: 'archived' as unknown as ArtifactJson['state'] })
      )
    ).toThrow();
  });

  it('rejects an unknown lineage event kind', () => {
    expect(() =>
      ArtifactJsonSchema.parse(
        validInput({
          branch_lineage: [
            {
              branch: 'main',
              head_sha: 'abc',
              ts: '2026-04-26T12:00:00.000Z',
              event: 'cherry-picked' as unknown as 'created',
            },
          ],
        })
      )
    ).toThrow();
  });

  it('rejects checkpoint_count < 0', () => {
    expect(() => ArtifactJsonSchema.parse(validInput({ checkpoint_count: -1 }))).toThrow();
  });

  it('rejects schema_version other than 1', () => {
    expect(() => ArtifactJsonSchema.parse(validInput({ schema_version: 2 as 1 }))).toThrow();
  });

  it('rejects non-ISO datetime in created_at', () => {
    expect(() =>
      ArtifactJsonSchema.parse(validInput({ created_at: '2026-04-26 12:00:00' }))
    ).toThrow();
  });
});

describe('writeArtifactJson', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-artifact-json-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function sample(): ArtifactJson {
    return {
      schema_version: 1,
      id: '01J9XR8M7K2QFGKW8',
      state: 'planned',
      branch_lineage: [
        {
          branch: 'feat/auth',
          head_sha: 'abc1234',
          ts: '2026-04-26T12:00:00.000Z',
          event: 'created',
        },
      ],
      created_by_session_id: 'sess_xyz',
      created_at: '2026-04-26T12:00:00.000Z',
      updated_at: '2026-04-26T12:00:00.000Z',
      checkpoint_count: 0,
      plan_revision_count: 0,
      plan_last_revised_at: null,
      source_event_id: 'evt_plan',
      source_plan: null,
      pre_pr_checked_head_sha: null,
      pre_pr_checked_source_event_id: null,
      baseline_seed_tree_sha: null,
      superseded_artifact_id: null,
    };
  }

  it('writes a schema-valid projection', async () => {
    const target = path.join(tmpRoot, 'a1', 'artifact.json');

    const data = sample();
    await writeArtifactJson(target, data);
    const written = ArtifactJsonSchema.parse(JSON.parse(await readFile(target, 'utf8')));
    expect(written).toEqual(data);
  });

  it('writes to a nested path that does not yet exist (atomic-write mkdir-p)', async () => {
    const target = path.join(tmpRoot, 'deep', 'nested', 'a1', 'artifact.json');
    await writeArtifactJson(target, sample());
    const written = JSON.parse(await readFile(target, 'utf8')) as { id: string };
    expect(written.id).toBe('01J9XR8M7K2QFGKW8');
  });

  it('writes valid JSON ending with a trailing newline', async () => {
    const target = path.join(tmpRoot, 'a1', 'artifact.json');
    await writeArtifactJson(target, sample());
    const raw = await readFile(target, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    // Round-trip via JSON.parse to confirm it's well-formed
    expect(JSON.parse(raw).id).toBe('01J9XR8M7K2QFGKW8');
  });

  it('writeArtifactJson rejects malformed input before touching disk', async () => {
    const target = path.join(tmpRoot, 'a1', 'artifact.json');
    const bad = { ...sample(), state: 'archived' as unknown as ArtifactJson['state'] };
    await expect(writeArtifactJson(target, bad)).rejects.toThrow();
    // Confirm no file was created
    await expect(readFile(target, 'utf8')).rejects.toThrow(/ENOENT/);
  });
});
