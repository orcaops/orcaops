import path from 'node:path';

import type { SeedFileOwnership } from '@orcaops/core';
import type { Config } from '@orcaops/storage';
import type {
  SeedCoverageReport,
  SeedDiscoveryArea,
  SeedJobRecord,
  SeedPreciousState,
} from '@orcaops/storage/history/seed-schema';

export function normalizeSeedArea(area: string): string {
  return area.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
}

export function rememberDeclinedSeedArea(
  state: SeedPreciousState,
  area: string,
  requestedPath: string | null = null,
  now = new Date()
): void {
  const normalized = normalizeSeedArea(area);
  if (!normalized) return;
  const prior = state.discovery_areas[normalized];
  const requested = requestedPath === null ? '' : normalizeSeedArea(requestedPath);
  const declinedPaths =
    requested !== '' && requested !== normalized
      ? [...new Set([...(prior?.declined_paths ?? []), requested])].sort()
      : prior?.declined_paths;
  state.discovery_areas[normalized] = {
    ...prior,
    declined_at: now.toISOString(),
    ...(declinedPaths !== undefined ? { declined_paths: declinedPaths } : {}),
  };
}

export function recordSeedAreaOffered(
  state: SeedPreciousState,
  area: string,
  now = new Date()
): void {
  const normalized = normalizeSeedArea(area);
  if (!normalized) return;
  state.discovery_areas[normalized] = {
    ...state.discovery_areas[normalized],
    offered_at: now.toISOString(),
  };
}

export function clearSeedArea(state: SeedPreciousState, area: string): boolean {
  const normalized = normalizeSeedArea(area);
  if (!normalized || state.discovery_areas[normalized] === undefined) return false;
  delete state.discovery_areas[normalized];
  return true;
}

export const SEED_OFFER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export function seedAreaSuppression(
  state: SeedPreciousState | null,
  area: string,
  now = new Date()
): 'declined' | 'offer-cooldown' | null {
  const record = state?.discovery_areas[normalizeSeedArea(area)];
  if (!record) return null;
  if (record.declined_at !== undefined) return 'declined';
  if (record.offered_at === undefined) return null;
  const offeredAt = Date.parse(record.offered_at);
  if (!Number.isFinite(offeredAt)) return null;
  return now.getTime() - offeredAt < SEED_OFFER_COOLDOWN_MS ? 'offer-cooldown' : null;
}

export function offeredSeedAreas(state: SeedPreciousState | null, now = new Date()) {
  if (!state) return [];
  return Object.entries(state.discovery_areas)
    .filter(([, record]) => record.declined_at === undefined && record.offered_at !== undefined)
    .map(([area, record]) => ({
      area,
      offered_at: record.offered_at!,
      cooldown_active: seedAreaSuppression(state, area, now) === 'offer-cooldown',
    }))
    .sort((left, right) => (left.area < right.area ? -1 : left.area > right.area ? 1 : 0));
}

export function declinedSeedAreas(state: SeedPreciousState | null): string[] {
  if (!state) return [];
  return Object.entries(state.discovery_areas)
    .filter(([, record]) => record.declined_at !== undefined)
    .map(([area]) => area)
    .sort();
}

export function buildSeedCoverageReport(
  branchSha: string,
  ownership: readonly SeedFileOwnership[],
  importedShas: ReadonlySet<string>,
  complete: boolean
): SeedCoverageReport {
  const totals = new Map<string, { covered: number; total: number }>();
  for (const file of ownership) {
    const directory = file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : '.';
    const current = totals.get(directory) ?? { covered: 0, total: 0 };
    current.total += file.lineCount;
    for (const [sha, count] of file.byCommit) {
      if (importedShas.has(sha)) current.covered += count;
    }
    totals.set(directory, current);
  }
  return {
    schema_version: 1,
    branch_sha: branchSha,
    generated_at: new Date().toISOString(),
    complete,
    directories: Object.fromEntries(
      [...totals]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([directory, value]) => [
          directory,
          {
            covered_lines: value.covered,
            total_lines: value.total,
            percent:
              value.total === 0 ? 0 : Math.round((value.covered / value.total) * 10_000) / 100,
          },
        ])
    ),
  };
}

export const SEED_JOB_RECORD_LIMIT = 20;

export function recordSeedJob(
  jobs: Record<string, SeedJobRecord>,
  jobId: string,
  record: SeedJobRecord
): void {
  jobs[jobId] = record;
  const newestFirst = Object.entries(jobs).sort(([, left], [, right]) =>
    left.started_at < right.started_at ? 1 : left.started_at > right.started_at ? -1 : 0
  );
  for (const [key] of newestFirst.slice(SEED_JOB_RECORD_LIMIT)) delete jobs[key];
}

export function declinedSeedAreaForPath(
  areas: Readonly<Record<string, SeedDiscoveryArea>>,
  repoRelativeFile: string
): string | null {
  return (
    Object.entries(areas).find(
      ([area, state]) =>
        state.declined_at !== undefined &&
        (repoRelativeFile === area || repoRelativeFile.startsWith(`${area}/`))
    )?.[0] ?? null
  );
}

export function seedStateDir(repoRoot: string, config: Pick<Config, 'cache'>): string {
  return path.join(repoRoot, path.dirname(config.cache.path), 'seed');
}
