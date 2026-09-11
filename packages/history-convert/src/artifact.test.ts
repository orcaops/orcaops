import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { decodeLegacyArtifact } from './artifact.js';
import { canonicalJson } from './legacy/storage/events/canonical-json.js';
import { resolveConfig } from './legacy/storage/schema/config.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/artifact-plan.json', import.meta.url), 'utf8')
) as Record<string, unknown>;
const artifactId = '01999999-9999-7000-8000-000000000001';
function record(n: number, type: string, payload: unknown) {
  const unsigned = {
    event_id: `01999999-9999-7000-8000-${String(n).padStart(12, '0')}`,
    type,
    ts: '2026-04-26T12:00:00.000Z',
    schema_version: 1,
    idempotency_key: `source-${n}`,
    payload,
  };
  return {
    ...unsigned,
    checksum: createHash('sha256').update(canonicalJson(unsigned)).digest('hex'),
  };
}
const bytes = (...rows: unknown[]) =>
  Buffer.from(rows.map((row) => JSON.stringify(row) + '\n').join(''));

describe('frozen artifact replay', () => {
  it('replays the pinned producer fixture while retaining its original record bytes', () => {
    const source = bytes(record(1, 'plan_captured', fixture));
    const result = decodeLegacyArtifact({ artifactId, bytes: source });
    expect(result.plan.task).toBe('do the thing');
    expect(result.plan.source_event_id).toBe(artifactId);
    expect(result.artifact.branch_lineage[0]!.branch).toBe('feat/x');
    expect(Buffer.from(result.log.bytesBase64, 'base64')).toEqual(source);
  });

  it('rejects a wrong source schema and another artifact identity before import', () => {
    for (const changed of [
      { ...fixture, schema_version: 3 },
      { ...fixture, artifact_id: '01999999-9999-7000-8000-000000000999' },
    ])
      expect(() =>
        decodeLegacyArtifact({ artifactId, bytes: bytes(record(1, 'plan_captured', changed)) })
      ).toThrow(expect.objectContaining({ code: 'SOURCE_INTEGRITY' }));
  });

  it('does not let a valid later plan hide a malformed historical revision', () => {
    const changed = { ...fixture, revision_n: 1, task: '' };
    const latest = { ...fixture, revision_n: 2 };
    expect(() =>
      decodeLegacyArtifact({
        artifactId,
        bytes: bytes(
          record(1, 'plan_captured', fixture),
          record(2, 'plan_revised', changed),
          record(3, 'plan_revised', latest)
        ),
      })
    ).toThrow(expect.objectContaining({ code: 'SOURCE_INTEGRITY' }));
  });

  it('keeps the accepted config predecessor normalization private and explicit', () => {
    expect(resolveConfig({ schema_version: 5 }).schema_version).toBe(6);
    expect(() => resolveConfig({ schema_version: 4 })).toThrow();
    expect(() => resolveConfig({ schema_version: 7 })).toThrow();
  });
});
