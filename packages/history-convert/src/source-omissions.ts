import path from 'node:path';

export interface LegacySourceScope {
  readonly kind: 'checkout' | 'archive' | 'git-administration';
  readonly root: string;
}

export interface LegacySourceOmission {
  readonly location: string;
  readonly family: 'task-review' | 'task-review-feedback' | 'task-review-refs';
  readonly state: 'intentionally-not-inspected';
}

export interface LegacyCanonicalTarget {
  readonly location: string;
  readonly kind:
    | 'project-database'
    | 'project-database-companion'
    | 'repository-registration'
    | 'worktree-registration';
}

export const CANONICAL_PROJECT_DATABASE = 'history.sqlite3';
export const CANONICAL_REPOSITORY_REGISTRATION = 'registration.json';
export const CANONICAL_WORKTREE_REGISTRATION = 'worktree.json';

export function legacySourceOmissions(scope: LegacySourceScope): LegacySourceOmission[] {
  if (scope.kind === 'git-administration') return [];
  const members: [string, LegacySourceOmission['family']][] =
    scope.kind === 'checkout'
      ? [
          ['.orcaops/reviews', 'task-review'],
          ['.orcaops/cache/review-feedback', 'task-review-feedback'],
        ]
      : [['reviews', 'task-review']];
  return members.map(([relative, family]) => ({
    location: path.resolve(scope.root, relative),
    family,
    state: 'intentionally-not-inspected',
  }));
}

// The converted database lives beside the legacy archive project, so its names
// are never legacy sources: a retry after target creation must still observe
// the original manifest. Presence is reported separately, never decoded here.
export function legacyCanonicalTargets(scope: LegacySourceScope): LegacyCanonicalTarget[] {
  // Registration markers are the conversion's own output under the Git administrative
  // directory. Like the target database they are named, never read as legacy sources, so a
  // conversion interrupted after its first publisher can still observe the same source proof
  // when it retries.
  if (scope.kind === 'git-administration')
    return [
      {
        location: path.resolve(scope.root, CANONICAL_REPOSITORY_REGISTRATION),
        kind: 'repository-registration',
      },
      {
        location: path.resolve(scope.root, CANONICAL_WORKTREE_REGISTRATION),
        kind: 'worktree-registration',
      },
    ];
  if (scope.kind !== 'archive') return [];
  return [
    { location: path.resolve(scope.root, CANONICAL_PROJECT_DATABASE), kind: 'project-database' },
    ...['-wal', '-shm', '-journal'].map((suffix) => ({
      location: path.resolve(scope.root, CANONICAL_PROJECT_DATABASE + suffix),
      kind: 'project-database-companion' as const,
    })),
  ];
}

export function isOmittedLegacyMember(location: string, scope?: LegacySourceScope | null): boolean {
  return Boolean(
    scope &&
    legacySourceOmissions(scope).some(
      (entry) => location === entry.location || location.startsWith(entry.location + path.sep)
    )
  );
}

export function isCanonicalTargetMember(
  location: string,
  scope?: LegacySourceScope | null
): boolean {
  return Boolean(
    scope && legacyCanonicalTargets(scope).some((entry) => location === entry.location)
  );
}

export function isExcludedLegacyMember(
  location: string,
  scope?: LegacySourceScope | null
): boolean {
  return isOmittedLegacyMember(location, scope) || isCanonicalTargetMember(location, scope);
}

export function containsLegacyOmission(
  location: string,
  scope?: LegacySourceScope | null
): boolean {
  return Boolean(
    scope &&
    legacySourceOmissions(scope).some((entry) => entry.location.startsWith(location + path.sep))
  );
}

export function containsExcludedLocation(
  location: string,
  scope?: LegacySourceScope | null
): boolean {
  return (
    containsLegacyOmission(location, scope) ||
    Boolean(
      scope &&
      legacyCanonicalTargets(scope).some((entry) => entry.location.startsWith(location + path.sep))
    )
  );
}

export function isOmittedLegacyRef(ref: string): boolean {
  return ref.startsWith('refs/orcaops/review/');
}
