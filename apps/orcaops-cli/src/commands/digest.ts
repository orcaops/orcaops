import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  writeErrorLine,
  writePipeFriendlyStdout,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import {
  type DatabaseDigestOptions,
  digestEvaluatorDescriptions,
  readDatabaseArtifactDigest,
  readDatabaseBranchDigest,
  validateDatabaseDigest,
} from '../lib/database-digest.js';
import { resolveDatabaseHistoryCommandContext } from '../lib/database-history-context.js';
import { closeFailedHistoryRead } from '../lib/history-reader-close.js';
import { historyScopeCommandError } from '../lib/history-scope-error.js';
import { getInvocationEnv } from '../lib/invocation-context.js';

export type DigestOptions = DatabaseDigestOptions;

/**
 * `orcaops digest` — render reviewer-facing captured work from the validated
 * project database. The read never caches a rendering: `--out` is the only write,
 * and it is an explicit user target.
 */
export async function digestAction(opts: DigestOptions = {}): Promise<void> {
  const wantJson = opts.json === true || opts.format === 'json';
  try {
    const prepared = validateDatabaseDigest(opts);
    const context = await resolveDatabaseHistoryCommandContext({
      profile: prepared.profile,
      selector: prepared.selector,
    });
    let result: Awaited<
      ReturnType<typeof readDatabaseArtifactDigest | typeof readDatabaseBranchDigest>
    >;
    try {
      const descriptions = await digestEvaluatorDescriptions(
        context.scope.gitContext?.worktreeRoot ?? process.cwd()
      );
      result =
        prepared.options.branchWide === true
          ? await readDatabaseBranchDigest(context, prepared, descriptions)
          : await readDatabaseArtifactDigest(context, prepared, getInvocationEnv(), descriptions);
    } catch (cause) {
      closeFailedHistoryRead(context.scope);
      throw cause;
    }
    context.scope.close();
    // The reader decides whether a note is warranted: an explicit --artifact selection
    // carries none even when the thread has no summary.
    const note = 'note' in result ? (result.note as string) : undefined;
    const siblings =
      'other_artifacts' in result
        ? (result.other_artifacts as Array<{ id: string; state: string | null }>)
        : [];
    const siblingCount =
      'other_artifact_count' in result ? (result.other_artifact_count as number) : 0;
    const siblingNote =
      siblingCount > 0
        ? `${siblingCount} other artifact(s) on this branch not digested: ` +
          siblings.map((row) => `${row.id.slice(0, 8)} (${row.state ?? 'unreadable'})`).join(', ') +
          (siblingCount > siblings.length ? `, … showing ${siblings.length}` : '') +
          ' — pass --artifact <id> to digest one of them'
        : undefined;
    const humanNotes = () => {
      if (note) writeTerminalSafeStderr(`note: ${note}\n`);
      if (siblingNote) writeTerminalSafeStderr(`note: ${siblingNote}\n`);
    };
    if (prepared.options.out !== undefined) {
      const outPath = path.resolve(prepared.options.out);
      await writeFile(
        outPath,
        wantJson ? `${JSON.stringify({ ok: true, ...result }, null, 2)}\n` : result.markdown,
        'utf8'
      );
      if (wantJson) emitOk({ ...result, written_to: outPath });
      else {
        humanNotes();
        writeTerminalSafeStdout(`Wrote digest → ${outPath}\n`);
      }
      return;
    }
    if (wantJson) {
      emitOk(result);
      return;
    }
    humanNotes();
    writePipeFriendlyStdout(result.markdown);
  } catch (cause) {
    const error = historyScopeCommandError(cause);
    if (wantJson) emitError(error);
    writeErrorLine(error);
    throw new CliExit(1);
  }
}
