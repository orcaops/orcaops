import { HistoryConversionError } from '@orcaops/history-convert';
import { HistoryError } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { OrcaopsError } from '../io/errors.js';
import { CliExit } from '../io/exit.js';
import {
  emitError,
  emitOk,
  scrubOutboundText,
  toErrorEnvelope,
  writeErrorLine,
  writeTerminalSafeStderr,
  writeTerminalSafeStdout,
} from '../io/output.js';
import {
  applyHistoryConversion,
  type HistoryConvertApply,
  type HistoryConvertPreview,
  previewHistoryConversion,
} from '../lib/history-convert.js';
import { getInvocationCwd, getInvocationEnv } from '../lib/invocation-context.js';
import { resolveExplicitOverride } from '../lib/resolve-root.js';

export interface HistoryConvertCommandOptions {
  readonly apply?: boolean;
  readonly offline?: boolean;
  readonly operationId?: string;
  readonly json?: boolean;
}

function renderDisclosures(disclosures: HistoryConvertApply['disclosures']): string[] {
  if (disclosures === null) return ['Attachment disclosures not re-derived on registration retry'];
  if (!disclosures.length) return [];
  const shown = [...disclosures]
    .sort(
      (a, b) => Number(b.kind === 'derived-fingerprint') - Number(a.kind === 'derived-fingerprint')
    )
    .slice(0, 20);
  return [
    `Retained attachment disclosures (${disclosures.length})`,
    ...shown.map(
      (entry) =>
        `  ${entry.kind} ${entry.fidelity}: ${entry.location}/${entry.relativePath}${entry.sourceEventId ? ` (event ${entry.sourceEventId})` : ''}`
    ),
    ...(disclosures.length > shown.length
      ? [`  ... ${disclosures.length - shown.length} more; use --json for the complete list`]
      : []),
    'Original bytes are preserved; readers validate fingerprints before using them as evidence.',
  ];
}

function renderPreview(preview: HistoryConvertPreview): string {
  const lines = [
    `Legacy profile   ${preview.profile}`,
    `Producer evidence ${preview.producerEvidence}`,
    `Project          ${preview.projectId}`,
    `Source manifest  ${preview.sourceManifestSha256}`,
    `Complete         ${preview.contentComplete ? 'yes' : 'no'}`,
    ...renderDisclosures(preview.disclosures),
    'Counts',
    ...Object.entries(preview.counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `  ${name.padEnd(24)} ${value}`),
    'Omitted without decoding',
    ...preview.omitted.map((entry) => `  ${entry.family.padEnd(24)} ${entry.location}`),
  ];
  if (preview.retained.length)
    lines.push(
      'Retained by hash, never converted',
      ...preview.retained.map((entry) => `  ${entry.family.padEnd(24)} ${entry.location}`)
    );
  if (preview.unclassified.length) {
    const shown = preview.unclassified.slice(0, 20);
    lines.push(
      'Unclassified sources',
      ...shown.map((entry) => `  ${entry.location}`),
      ...(preview.unclassified.length > shown.length
        ? [
            `  ... ${preview.unclassified.length - shown.length} more; use --json for the complete list`,
          ]
        : [])
    );
  }
  if (preview.target)
    lines.push(
      'Target',
      `  database                 ${preview.target.database.state}`,
      `  catalog                  ${preview.target.catalog.state}`
    );
  if (preview.issues.length)
    lines.push(
      'Issues',
      ...preview.issues.map((issue) => `  ${issue.code.padEnd(24)} ${issue.location}`)
    );
  return lines.join('\n');
}

function renderApply(result: HistoryConvertApply): string {
  return [
    `Converted        ${result.convertedDatabase}`,
    `Producer evidence ${result.producerEvidence}`,
    `Operation        ${result.operationId}`,
    `Replayed         ${result.replayed ? 'yes' : 'no'}`,
    `Comparison       ${
      result.comparison === null
        ? 'not re-derived; this run completed the registration of an import that already committed'
        : result.comparison.ok
          ? 'every family matched'
          : 'MISMATCH'
    }`,
    ...(result.comparison?.families ?? []).map(
      (family) => `  ${family.family.padEnd(20)} ${family.observed}`
    ),
    ...renderDisclosures(result.disclosures),
    `Registration     repository ${result.registration.repository}, catalog ${result.registration.catalog}, worktree ${result.registration.worktree}`,
  ].join('\n');
}

export function createHistoryConvertAction() {
  return async (input: HistoryConvertCommandOptions = {}): Promise<void> => {
    const json = input !== null && typeof input === 'object' && input.json === true;
    let retry:
      | { operation_id: string; cwd: string; resolved_root: string; command: string }
      | undefined;
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    // Ctrl-C cancels an apply before it commits. The target it created exclusively stays on
    // disk, unregistered, and a retry by the same operation ID converges on it.
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    try {
      const options = {
        cwd: (await resolveExplicitOverride(getInvocationCwd())) ?? getInvocationCwd(),
        env: getInvocationEnv(),
        offline: input.offline,
        operationId: input.operationId,
        onOperationId: (id: string, context: { cwd: string; resolvedRoot: string }) => {
          retry = {
            operation_id: id,
            cwd: context.cwd,
            resolved_root: context.resolvedRoot,
            command: `ORCAOPS_DATA_DIR=${quote(context.resolvedRoot)} orcaops --root ${quote(context.cwd)} history convert --apply --offline --operation-id ${id}`,
          };
          writeTerminalSafeStderr(
            `Conversion operation: ${id}\nAfter an interruption, resume the same checkout and data root with: ${retry.command}\n`
          );
        },
        signal: controller.signal,
      };
      if (input.apply === true) {
        const result = await applyHistoryConversion(options);
        if (json) emitOk(result);
        else writeTerminalSafeStdout(renderApply(result));
        return;
      }
      if (input.offline === true || input.operationId !== undefined)
        throw new OrcaopsError(
          'INVALID_INPUT',
          'Offline windows and original operation IDs belong to --apply; a preview writes nothing'
        );
      const preview = await previewHistoryConversion(options);
      if (json) emitOk(preview);
      else writeTerminalSafeStdout(renderPreview(preview));
    } catch (cause) {
      let error =
        cause instanceof ProjectDatabaseError || cause instanceof OrcaopsError
          ? cause
          : cause instanceof HistoryConversionError || cause instanceof HistoryError
            ? new OrcaopsError(cause.code, scrubOutboundText(cause.message))
            : cause;
      if (retry !== undefined) {
        const { code, message, path, ...details } = toErrorEnvelope(error).error;
        error = new OrcaopsError(
          code,
          `${message} Conversion operation: ${retry.operation_id}. Preserve its history; if retry is safe after resolving this error, use: ${retry.command}`,
          path,
          {
            ...details,
            conversion_retry: retry,
          }
        );
      }
      if (json) emitError(error);
      writeErrorLine(error);
      throw new CliExit(1);
    } finally {
      process.off('SIGINT', interrupt);
    }
  };
}
