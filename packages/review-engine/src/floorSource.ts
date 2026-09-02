import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { type Floor, floorSchema } from '@orcaops/review-core';

import { FLOOR_PRODUCER_VERSION } from './floor.js';

export interface HealthyFloorSource {
  floor: Floor;
  diffText: string;
  floorFingerprint: string;
}

export type FloorBundleInspection =
  | { status: 'HEALTHY'; floor: Floor; diffText: string; floorFingerprint: string }
  | { status: 'ABSENT' }
  | { status: 'INVALID'; reason: string; incompatibleMarker: boolean };

type MemberRead =
  | { status: 'READ'; text: string }
  | { status: 'ABSENT' }
  | { status: 'ERROR'; reason: string };

async function readMember(file: string): Promise<MemberRead> {
  try {
    return { status: 'READ', text: await readFile(file, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'ABSENT' };
    return { status: 'ERROR', reason: error instanceof Error ? error.message : String(error) };
  }
}

const invalid = (reason: string): FloorBundleInspection => ({
  status: 'INVALID',
  reason,
  incompatibleMarker: false,
});

interface BundleSnapshot {
  marker: MemberRead;
  floorRaw: MemberRead;
  diff: MemberRead;
}

/**
 * The install protocol removes the marker FIRST and writes it LAST. Re-reading
 * it catches an overlapping install when the marker is absent or changes. A
 * reinstall may restore identical marker bytes; the cache contract treats those
 * generations as equivalent because the fingerprint covers the inputs that
 * determine the diff and substantive floor content (excluding only live floor
 * metadata). This runs UNLOCKED on purpose: review state reset holds the review
 * lock while re-inspecting, and a health probe must not queue behind an install.
 */
async function snapshotBundle(dir: string): Promise<BundleSnapshot | 'TORN'> {
  const markerPath = path.join(dir, 'floor-cache.json');
  const marker = await readMember(markerPath);
  const [floorRaw, diff] = await Promise.all([
    readMember(path.join(dir, 'floor.json')),
    readMember(path.join(dir, 'diff.patch')),
  ]);
  if (marker.status === 'READ') {
    const confirm = await readMember(markerPath);
    if (confirm.status !== 'READ' || confirm.text !== marker.text) return 'TORN';
  }
  return { marker, floorRaw, diff };
}

/**
 * Non-throwing bundle inspection shared with `loadHealthyFloorSource` — the
 * single definition of "healthy floor", so a health surface can never bless a
 * bundle the loader rejects. The marker is the commit record written LAST by a
 * successful `review data` install; any other member combination is a
 * crash/degraded partial bundle, not a readable floor.
 */
export async function inspectFloorBundle(
  root: string,
  branchSlug: string
): Promise<FloorBundleInspection> {
  const dir = path.join(root, '.orcaops', 'reviews', branchSlug);
  let snapshot = await snapshotBundle(dir);
  if (snapshot === 'TORN') snapshot = await snapshotBundle(dir);
  if (snapshot === 'TORN') {
    return invalid('floor bundle changed while being inspected; retry once review data completes');
  }
  const { marker, floorRaw, diff } = snapshot;
  if (marker.status === 'ABSENT' && floorRaw.status === 'ABSENT' && diff.status === 'ABSENT') {
    return { status: 'ABSENT' };
  }
  for (const [name, member] of [
    ['floor.json', floorRaw],
    ['diff.patch', diff],
    ['floor-cache.json', marker],
  ] as const) {
    if (member.status === 'ABSENT') return invalid(`${name} is missing from the floor bundle`);
    if (member.status === 'ERROR') return invalid(`${name} is unreadable: ${member.reason}`);
  }

  let decodedMarker: unknown;
  try {
    decodedMarker = JSON.parse((marker as { text: string }).text) as unknown;
  } catch (error) {
    return invalid(
      `floor-cache.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (
    decodedMarker === null ||
    typeof decodedMarker !== 'object' ||
    (decodedMarker as Record<string, unknown>).producerVersion !== FLOOR_PRODUCER_VERSION ||
    typeof (decodedMarker as Record<string, unknown>).floorFingerprint !== 'string' ||
    (decodedMarker as Record<string, unknown>).floorFingerprint === ''
  ) {
    return {
      status: 'INVALID',
      reason: 'floor-cache.json producer marker does not commit this bundle; run review data again',
      incompatibleMarker: true,
    };
  }

  let decodedFloor: unknown;
  try {
    decodedFloor = JSON.parse((floorRaw as { text: string }).text) as unknown;
  } catch (error) {
    return invalid(
      `floor.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const parsedFloor = floorSchema.safeParse(decodedFloor);
  if (!parsedFloor.success) {
    const issues = parsedFloor.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return invalid(`floor.json violates the current schema: ${issues}`);
  }

  return {
    status: 'HEALTHY',
    floor: parsedFloor.data,
    diffText: (diff as { text: string }).text,
    floorFingerprint: (decodedMarker as { floorFingerprint: string }).floorFingerprint,
  };
}

/**
 * A floor read is healthy only when it has the producer marker written by the
 * successful floor-cache commit. A merely parseable floor is not enough.
 */
export async function loadHealthyFloorSource(
  root: string,
  branchSlug: string
): Promise<HealthyFloorSource> {
  const dir = path.join(root, '.orcaops', 'reviews', branchSlug);
  const inspected = await inspectFloorBundle(root, branchSlug);
  if (inspected.status === 'HEALTHY') {
    return {
      floor: inspected.floor,
      diffText: inspected.diffText,
      floorFingerprint: inspected.floorFingerprint,
    };
  }
  if (inspected.status === 'INVALID' && inspected.incompatibleMarker) {
    throw new Error(
      `floor cache health gate failed at ${path.join(dir, 'floor-cache.json')}; run review data again`
    );
  }
  throw new Error(`no healthy floor at ${dir}; run review data first`);
}
