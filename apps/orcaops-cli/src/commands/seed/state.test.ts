import { describe, expect, it } from 'vitest';

import type { SeedJobRecord, SeedPreciousState } from '@orcaops/storage/history/seed-schema';

import {
  buildSeedCoverageReport,
  clearSeedArea,
  declinedSeedAreaForPath,
  declinedSeedAreas,
  offeredSeedAreas,
  recordSeedAreaOffered,
  recordSeedJob,
  rememberDeclinedSeedArea,
  SEED_JOB_RECORD_LIMIT,
  SEED_OFFER_COOLDOWN_MS,
  seedAreaSuppression,
} from './state.js';

describe('discovery-area suppression', () => {
  const now = new Date('2026-03-01T00:00:00.000Z');
  const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString();
  const state = (areas: Record<string, { declined_at?: string | null; offered_at?: string }>) => ({
    schema_version: 1 as const,
    install_nonce: 'b'.repeat(32),
    pr_context: false,
    pending_importance: false,
    commit_graph_hint_shown: false,
    discovery_areas: areas,
    updated_at: now.toISOString(),
  });

  it('records normalized declined areas once', () => {
    const current = state({});
    rememberDeclinedSeedArea(current, './src/server/', null, now);
    rememberDeclinedSeedArea(current, 'src/server', null, now);
    rememberDeclinedSeedArea(current, '   ', null, now);
    expect(declinedSeedAreas(current)).toEqual(['src/server']);
    expect(current.discovery_areas['src/server']?.declined_at).toBe(now.toISOString());
  });

  it('records the originally requested path beside a widened decline area', () => {
    const current: SeedPreciousState = state({});
    rememberDeclinedSeedArea(current, 'apps', 'apps/orcaops-cli', now);
    rememberDeclinedSeedArea(current, 'apps', './apps/orcaops-watch/', now);
    rememberDeclinedSeedArea(current, 'apps', 'apps', now);
    expect(declinedSeedAreas(current)).toEqual(['apps']);
    expect(current.discovery_areas.apps?.declined_paths).toEqual([
      'apps/orcaops-cli',
      'apps/orcaops-watch',
    ]);
  });

  it('preserves a known decline with an unknown date through JSON and path hints', () => {
    const original = state({ src: { declined_at: null }, docs: {} });
    const restored = JSON.parse(JSON.stringify(original));
    expect(restored.discovery_areas.src.declined_at).toBeNull();
    expect(seedAreaSuppression(restored, 'src', now)).toBe('declined');
    expect(declinedSeedAreas(restored)).toEqual(['src']);
    expect(offeredSeedAreas(restored, now)).toEqual([]);
    expect(declinedSeedAreaForPath(restored.discovery_areas, 'src/file.ts')).toBe('src');
    expect(declinedSeedAreaForPath(restored.discovery_areas, 'src-other/file.ts')).toBeNull();
    expect(declinedSeedAreaForPath(restored.discovery_areas, 'docs/file.md')).toBeNull();
  });

  it('suppresses a declined area permanently and an offer only during its cooldown', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(seedAreaSuppression(state({}), 'src', now)).toBeNull();
    expect(seedAreaSuppression(state({ src: { offered_at: ago(2 * day) } }), 'src', now)).toBe(
      'offer-cooldown'
    );
    expect(
      seedAreaSuppression(state({ src: { offered_at: ago(8 * day) } }), 'src', now)
    ).toBeNull();
    expect(
      seedAreaSuppression(state({ src: { offered_at: ago(SEED_OFFER_COOLDOWN_MS) } }), 'src', now)
    ).toBeNull();
    expect(
      seedAreaSuppression(
        state({ src: { declined_at: ago(400 * day), offered_at: ago(400 * day) } }),
        'src',
        now
      )
    ).toBe('declined');
    expect(seedAreaSuppression(state({ src: { declined_at: ago(day) } }), './src/', now)).toBe(
      'declined'
    );
  });

  it('stamps an offer and clears one remembered area', () => {
    const current = state({ frontend: { declined_at: ago(1000) } });
    recordSeedAreaOffered(current, './src/', now);
    expect(offeredSeedAreas(current, now)).toEqual([
      { area: 'src', offered_at: now.toISOString(), cooldown_active: true },
    ]);
    expect(offeredSeedAreas(current, now).map((offer) => offer.area)).not.toContain('frontend');

    expect(clearSeedArea(current, 'src')).toBe(true);
    expect(clearSeedArea(current, 'src')).toBe(false);
    expect(seedAreaSuppression(current, 'src', now)).toBeNull();
    expect(clearSeedArea(current, './frontend/')).toBe(true);
    expect(declinedSeedAreas(current)).toEqual([]);
  });
});

describe('recordSeedJob', () => {
  const record = (startedAt: string): SeedJobRecord => ({
    kind: 'initial',
    started_at: startedAt,
  });

  it('keeps the newest run extras and drops the oldest past the cap', () => {
    const jobs: Record<string, SeedJobRecord> = {};
    for (let index = 0; index < SEED_JOB_RECORD_LIMIT + 5; index++) {
      const day = String(index + 1).padStart(2, '0');
      recordSeedJob(jobs, `job-${index}`, record(`2026-01-${day}T00:00:00.000Z`));
    }
    expect(Object.keys(jobs)).toHaveLength(SEED_JOB_RECORD_LIMIT);
    expect(jobs).not.toHaveProperty('job-0');
    expect(jobs).toHaveProperty(`job-${SEED_JOB_RECORD_LIMIT + 4}`);
  });
});

describe('buildSeedCoverageReport', () => {
  it('reports imported living-line coverage per top-level directory', () => {
    const imported = 'a'.repeat(40);
    const report = buildSeedCoverageReport(
      'b'.repeat(40),
      [
        {
          path: 'src/a.ts',
          lineCount: 4,
          byCommit: new Map([
            [imported, 3],
            ['c'.repeat(40), 1],
          ]),
          complete: true,
        },
        {
          path: 'README.md',
          lineCount: 2,
          byCommit: new Map([[imported, 2]]),
          complete: true,
        },
      ],
      new Set([imported]),
      true
    );
    expect(report.directories).toEqual({
      '.': { covered_lines: 2, total_lines: 2, percent: 100 },
      src: { covered_lines: 3, total_lines: 4, percent: 75 },
    });
  });
});
