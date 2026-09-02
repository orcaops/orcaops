// Write-through archive wiring for the review append logs (journal + comments).
//
// The review verbs run in the sidecar with only a `root` — they never build a
// CLI `buildContext`, so there is no shared `ArchiveMirror` to borrow. This
// module resolves one locally from the same inputs the CLI's
// `buildArchiveContext` uses: config (`archive.enabled` + `redact_secrets`),
// the archive data root (env), and the repo's minted project id (git config).
//
// Both the journal and the comments log mirror whenever the archive is
// enabled; the mirroring happens here plus the two append sites in
// journal.ts / comments.ts.
// `packages/storage/src/archive/mirror.ts#mirrorReviewEvent` carries the
// matching note on the storage side.

import { loadConfig, Repo } from '@orcaops/core';
import { ProjectIdentityError, readProjectId } from '@orcaops/project-scope';
import {
  archiveLocksDir,
  ArchiveMirror,
  archiveProjectDir,
  archiveRoot,
  indexRoot,
} from '@orcaops/storage';

export const REVIEW_ARCHIVE_WARNING_CODE = {
  SETUP_FAILED: 'REVIEW_ARCHIVE_SETUP_FAILED',
  WRITE_FAILED: 'REVIEW_ARCHIVE_WRITE_FAILED',
} as const;

export interface ReviewArchiveWarning {
  code: (typeof REVIEW_ARCHIVE_WARNING_CODE)[keyof typeof REVIEW_ARCHIVE_WARNING_CODE];
  message: string;
}

export interface ReviewArchiveContext {
  mirror: ArchiveMirror | null;
  warnings: ReviewArchiveWarning[];
}

/** Resolve the fail-open review archive and collect invocation-scoped warnings. */
export async function reviewArchiveMirror(
  root: string,
  env: NodeJS.ProcessEnv
): Promise<ReviewArchiveContext> {
  const warnings: ReviewArchiveWarning[] = [];
  try {
    const config = await loadConfig(root);
    if (!config.archive.enabled) return { mirror: null, warnings };
    const projectId = await readProjectId(new Repo(root));
    if (!projectId) {
      warnings.push({
        code: REVIEW_ARCHIVE_WARNING_CODE.SETUP_FAILED,
        message:
          'Archive mirroring is enabled but this repository has no project identity; ' +
          'the review event was written only to the hot store.',
      });
      return { mirror: null, warnings };
    }
    const dataRoot = archiveRoot(env);
    return {
      mirror: new ArchiveMirror({
        projectDir: archiveProjectDir(dataRoot, projectId),
        locksDir: archiveLocksDir(indexRoot(env), projectId),
        redactSecrets: config.archive.redact_secrets,
        onWarn: (message) =>
          warnings.push({ code: REVIEW_ARCHIVE_WARNING_CODE.WRITE_FAILED, message }),
      }),
      warnings,
    };
  } catch (error) {
    warnings.push({
      code: REVIEW_ARCHIVE_WARNING_CODE.SETUP_FAILED,
      message:
        error instanceof ProjectIdentityError
          ? error.message
          : `Review archive setup failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { mirror: null, warnings };
  }
}
