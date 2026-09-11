// The public `review pane` verb. A pure read: it never mints a review or opens
// a writer, so it takes no operation id. The payload can be multi-megabyte (the
// diff), so the sidecar caller collects stdout incrementally; this prints it as
// one JSON line.

import { HistoryScopeError } from '@orcaops/project-scope/history/database';
import { HistoryError } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { readDatabaseReviewPane, readDatabaseReviewPaneGenerations } from './pane.js';
import { writeReviewError, writeReviewOutput } from '../reviewFiles.js';

function paneFailure(error: unknown) {
  if (
    error instanceof ProjectDatabaseError ||
    error instanceof HistoryScopeError ||
    error instanceof HistoryError
  )
    return { code: error.code, message: error.message };
  return {
    code: 'HISTORY_INACCESSIBLE',
    message:
      error instanceof Error
        ? error.message
        : 'Review pane could not access its required history; inspect storage before retrying',
  };
}

export async function runDatabaseReviewPane(
  args: { branch?: string; projectId?: string; generationsOnly?: boolean },
  root: string
): Promise<number> {
  if (!args.branch) {
    writeReviewError('review pane: --branch <branch> is required\n');
    return 1;
  }
  try {
    // A review with no selected floor prints an explicit availability envelope
    // rather than a floorless pane the reader would have to special-case.
    if (args.generationsOnly === true) {
      // The cheap probe: only the change tokens — the selection, comment heads,
      // workflow depth and the Story/anchor generations — without hydrating the
      // floor diff, the Story model or the comment and run histories the full
      // pane assembles. (A Story with a model still reads its anchor generation,
      // same as the full pane; the savings are the bodies, not that read.)
      const generations = await readDatabaseReviewPaneGenerations({
        branch: args.branch,
        cwd: root,
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
      });
      if (generations === null) {
        writeReviewOutput(`${JSON.stringify({ ok: false, code: 'REVIEW_NOT_FOUND' })}\n`);
        return 1;
      }
      writeReviewOutput(`${JSON.stringify({ ok: true, generations: generations.generations })}\n`);
      return 0;
    }
    const pane = await readDatabaseReviewPane({
      branch: args.branch,
      cwd: root,
      ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
    });
    if (pane === null) {
      writeReviewOutput(`${JSON.stringify({ ok: false, code: 'REVIEW_NOT_FOUND' })}\n`);
      return 1;
    }
    writeReviewOutput(`${JSON.stringify({ ok: true, ...pane })}\n`);
    return 0;
  } catch (cause) {
    const error = paneFailure(cause);
    writeReviewOutput(`${JSON.stringify({ ok: false, ...error })}\n`);
    return error.code === 'INVALID_INPUT' ? 2 : 1;
  }
}
