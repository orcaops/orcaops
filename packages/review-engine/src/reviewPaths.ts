import path from 'node:path';

import { assertResolvedWithin, assertSafePathSegment } from '@orcaops/storage';

export function reviewRootPath(root: string): string {
  return assertResolvedWithin(path.join(root, '.orcaops', 'reviews'), root, 'review state root', {
    rejectSymlinks: true,
  });
}

export function reviewDirPath(root: string, branchSlug: string): string {
  assertSafePathSegment(branchSlug, 'review branch slug');
  return assertResolvedWithin(
    path.join(root, '.orcaops', 'reviews', branchSlug),
    root,
    'review state directory',
    { rejectSymlinks: true }
  );
}

export function reviewEntryPath(root: string, target: string, label: string): string {
  return assertResolvedWithin(target, root, label, { rejectSymlinks: true });
}
