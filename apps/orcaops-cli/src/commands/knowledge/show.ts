import path from 'node:path';
import { z } from 'zod';

import { stringifyTerminalSafeJson } from '@orcaops/evaluator-protocol/terminal';
import {
  expandProjectRationaleContext,
  parseRationaleSelector,
  ProjectDatabaseError,
  RATIONALE_EXPORT_SOURCE_BYTES,
} from '@orcaops/storage/history/database';

import { emitOk, writeTerminalSafeStdout } from '../../io/output.js';
import { resolveDatabaseHistoryCommandContext } from '../../lib/database-history-context.js';
import {
  inspectionArgument as argument,
  emitInspectionError,
  EXPORT_BYTES,
  exportInspection,
  INSPECTION_BYTES,
  INSPECTION_DETAILS_BYTES,
  inspectionBytes,
  measuredInspection,
  validateExportPath,
} from '../../lib/inspection-output.js';
import { getInvocationCwd } from '../../lib/invocation-context.js';
import { currentAccountStatus } from '../../lib/knowledge-account-status.js';

interface KnowledgeShowOptions {
  project?: string;
  scope?: string;
  json?: boolean;
  details?: boolean;
  context?: boolean;
  cursor?: string;
  limit?: string;
  output?: string;
}

export async function knowledgeShowAction(
  reference: string,
  options: KnowledgeShowOptions = {}
): Promise<void> {
  try {
    parseRationaleSelector(reference);
    validateExportPath(options.output);
    const artifact =
      options.scope !== undefined && options.scope !== 'project'
        ? options.scope.startsWith('artifact:')
          ? options.scope.slice('artifact:'.length)
          : ''
        : undefined;
    if (artifact !== undefined && !z.uuid().safeParse(artifact).success)
      throw new ProjectDatabaseError('INVALID_INPUT', '--scope takes project or artifact:<id>');
    if ((options.cursor || options.limit !== undefined) && !options.context)
      throw new ProjectDatabaseError('INVALID_INPUT', 'Context pagination requires --context');
    if (options.limit !== undefined && !/^[1-8]$/.test(options.limit))
      throw new ProjectDatabaseError('INVALID_INPUT', 'Context --limit must be between 1 and 8');
    const ceiling = options.details ? INSPECTION_DETAILS_BYTES : INSPECTION_BYTES;
    const baseCommand = `orcaops knowledge show ${argument(reference)}${options.project ? ` --project ${argument(options.project)}` : ''}${artifact ? ` --scope artifact:${artifact}` : ''}`;
    const command = `${baseCommand}${options.context ? ' --context' : ''}${options.cursor ? ` --cursor ${argument(options.cursor)}` : ''}${options.limit ? ` --limit ${options.limit}` : ''}`;
    const selection = {
      reference,
      context: options.context ?? false,
      mode: 'current' as const,
    };
    const receipt = {
      schema_version: 2,
      representation: 'export_receipt',
      status: 'exported',
      selection,
      file: {
        path: options.output ? path.resolve(getInvocationCwd(), options.output) : '',
        bytes: EXPORT_BYTES,
      },
    };
    if (options.output) measuredInspection(receipt);
    const context = await resolveDatabaseHistoryCommandContext({
      profile: 'status',
      selector: { scope: 'project', ...(options.project ? { projectId: options.project } : {}) },
    });
    let result: ReturnType<typeof expandProjectRationaleContext>['value'];
    let recovery:
      | Extract<ReturnType<typeof expandProjectRationaleContext>['value'], { status: 'available' }>
      | undefined;
    try {
      const project = context.scope.projects[0];
      if (context.scope.projects.length !== 1 || !project?.database)
        throw new ProjectDatabaseError(
          'HISTORY_MISSING',
          'Select one available project with --project or run in its checkout'
        );
      const expanded = expandProjectRationaleContext(project.database, reference, {
        cursor: options.cursor,
        limit: options.limit === undefined ? undefined : Number(options.limit),
        export: !!options.output && !!options.context,
        artifact,
      }).value;
      if (expanded.status === 'available') recovery = expanded;
      result = expanded;
    } finally {
      context.scope.close();
    }
    const { qualifications: _qualifications, ...summary } = recovery ?? {
      qualifications: undefined,
    };
    const envelope = {
      schema_version: 2,
      representation: options.context ? 'qualified_account' : 'account',
      ...(recovery && !options.context
        ? { ...summary, current_status: currentAccountStatus(recovery) }
        : result),
      qualification_status: options.context
        ? recovery
          ? 'included_with_coverage'
          : 'unavailable'
        : recovery
          ? 'included_summary'
          : 'unavailable',
      follow_up: {
        ...(!options.context && recovery?.qualifications.length
          ? { qualifications: `${baseCommand} --context --json` }
          : {}),
        ...(recovery?.pagination.next_cursor
          ? {
              next: `${baseCommand} --context --cursor ${recovery.pagination.next_cursor}${options.limit ? ` --limit ${options.limit}` : ''} --json`,
            }
          : {}),
      },
      limits: {
        source_bytes: RATIONALE_EXPORT_SOURCE_BYTES,
      },
    };
    let response: object;
    if (options.output && result.status === 'available') {
      response = measuredInspection({
        ...receipt,
        completeness: recovery?.completeness ?? { complete: true, selection: 'account_only' },
        file: await exportInspection(options.output, envelope),
      });
    } else if (
      inspectionBytes({ ...envelope, output: { ceiling_bytes: ceiling, bytes: ceiling } }) <=
      ceiling
    ) {
      response = measuredInspection(envelope, ceiling);
    } else {
      response = measuredInspection(
        {
          schema_version: 2,
          representation: envelope.representation,
          status: 'omitted_oversized',
          ...selection,
          content: null,
          content_bytes: inspectionBytes(envelope),
          reason:
            'The complete selected account and qualifications exceed the display allowance. No wording was clipped. Export the selection before relying on omitted qualifications.',
          ...(recovery
            ? { pagination: recovery.pagination, completeness: recovery.completeness }
            : {}),
          qualification_status: 'omitted',
          follow_up: {
            ...envelope.follow_up,
            export: `${command} --output <new-file.json> --json`,
          },
          limits: envelope.limits,
        },
        ceiling
      );
    }
    if (options.json) emitOk(response);
    else {
      const pretty = JSON.stringify({ ok: true, ...response }, null, 2) + '\n';
      writeTerminalSafeStdout(
        Buffer.byteLength(pretty) <= ceiling
          ? pretty
          : stringifyTerminalSafeJson({ ok: true, ...response }) + '\n'
      );
    }
  } catch (cause) {
    emitInspectionError(cause, options.json ?? false);
  }
}
