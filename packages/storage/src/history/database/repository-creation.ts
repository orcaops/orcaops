import path from 'node:path';

import type { ProjectDatabase } from './connection.js';
import { ProjectDatabaseError, type ProjectDatabaseErrorCode } from './errors.js';

export interface RepositoryCreation {
  readonly commonDirectory: string;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string | null;
}

export function copyRepositoryCreation(
  value: RepositoryCreation,
  code: ProjectDatabaseErrorCode = 'INVALID_INPUT'
): Readonly<RepositoryCreation> {
  if (!value || typeof value !== 'object')
    throw new ProjectDatabaseError(
      code,
      'Provide original repository creation facts; missing provenance requires explicit identity repair'
    );
  const result = {
    commonDirectory: value.commonDirectory,
    device: value.device,
    inode: value.inode,
    birthtimeNs: value.birthtimeNs,
  };
  const integer = (text: unknown, zero: boolean) =>
    typeof text === 'string' &&
    text.length <= 40 &&
    (zero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(text);
  if (
    typeof result.commonDirectory !== 'string' ||
    !path.isAbsolute(result.commonDirectory) ||
    path.normalize(result.commonDirectory) !== result.commonDirectory ||
    !integer(result.device, true) ||
    !integer(result.inode, false) ||
    (result.birthtimeNs !== null && !integer(result.birthtimeNs, false))
  ) {
    throw new ProjectDatabaseError(
      code,
      'Repository creation requires a canonical locator and exact observed directory identity; inspect original provenance before retrying'
    );
  }
  return Object.freeze(result);
}

export function readProjectRepositoryCreation(
  handle: ProjectDatabase
): Readonly<RepositoryCreation> | null {
  return handle.read((view) => {
    const row = view.get<RepositoryCreation>(
      `SELECT common_directory AS commonDirectory, device, inode, birthtime_ns AS birthtimeNs
       FROM repository_creation WHERE singleton = 1`
    );
    return row ? copyRepositoryCreation(row, 'HISTORY_INTEGRITY_REQUIRED') : null;
  }).value;
}
