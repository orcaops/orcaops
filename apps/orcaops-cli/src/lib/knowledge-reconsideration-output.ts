import type { ConsequenceLimit } from '@orcaops/core';
import type {
  ProjectReconsiderationDisposition,
  ProjectReconsiderationItem,
} from '@orcaops/storage/history/database';

import type {
  ReconsiderationBasis,
  ReconsiderationListReport,
  ReconsiderationOpenReport,
} from '../commands/knowledge/reconsider.js';

/**
 * The facts a reader needs from an item's retained record. The record is JSON somebody else's
 * layer wrote, so every field is read defensively: a row this build cannot make sense of is
 * rendered as the little it can say, never as an item with no cause.
 */
interface ItemSource {
  reason?: unknown;
  basis?: unknown;
  cause?: { change?: unknown };
  path?: unknown;
}

const sourceOf = (item: ProjectReconsiderationItem): ItemSource =>
  item.source !== null && typeof item.source === 'object' ? (item.source as ItemSource) : {};

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const describeBasis = (basis: ReconsiderationBasis): string =>
  `write sequence ${basis.knowledge_boundary} (${basis.mode}), ` +
  (basis.scope.kind === 'project'
    ? `project ${basis.scope.project_id}`
    : `artifact ${basis.scope.artifact_id}`);

const describeLimits = (limits: readonly ConsequenceLimit[], indent: string): string[] =>
  limits.length === 0
    ? [`${indent}Limits: none this read could name.`]
    : [
        `${indent}Limits (${limits.length})`,
        ...limits.map((limit) => `${indent}  - ${limit.kind}: ${limit.detail}`),
      ];

function describeDisposition(entry: ProjectReconsiderationDisposition): string {
  const who = entry.disposedBy === null ? 'nobody named' : entry.disposedBy;
  const what =
    entry.disposition === 'reconsidered'
      ? `reconsidered → ${
          entry.outcome === null
            ? 'no outcome recorded'
            : entry.outcome.kind === 'unchanged'
              ? 'unchanged'
              : entry.outcome.kind === 'revision'
                ? `revision ${entry.outcome.revision_id}`
                : `assessment ${entry.outcome.assessment_id}`
        }`
      : entry.disposition === 'declined'
        ? `declined — ${entry.reason ?? ''}`
        : entry.disposition === 'superseded'
          ? `superseded by ${entry.supersededByItemId ?? ''}`
          : 'acknowledged';
  return `${what}, by ${who} (${entry.disposedByBasis}) at ${entry.disposedAt}`;
}

function describeItem(item: ProjectReconsiderationItem, position: number): string[] {
  const source = sourceOf(item);
  const lines = [
    `  ${position}. ${item.itemId}`,
    `     About: ${item.affected.kind} ${item.affected.id}`,
    `     Cause: ${item.causeKind} — ${JSON.stringify(source.cause?.change ?? null)}`,
    `     Why: ${text(source.reason) ?? 'the record carries no reason this build can read'}`,
    `     Opened at write sequence ${item.openedAtBoundary}, retained at ${item.writeSequence}` +
      `${text(source.basis) === null ? '' : `, ${text(source.basis)} throughout`}`,
  ];
  if (item.owner !== null)
    lines.push(`     Owner: ${item.owner.name} (${item.owner.basis}) — ${item.owner.from}`);
  lines.push(
    item.dispositions.length === 0
      ? '     Disposition: none yet; it is open.'
      : `     Dispositions (${item.dispositions.length})`
  );
  for (const entry of item.dispositions)
    lines.push(`       ${entry.position}. ${describeDisposition(entry)}`);
  return lines;
}

/**
 * What `open` wrote, as a person reads it. The items it opened lead, the items the store already
 * held follow as retained, and the statement closes it so nothing here is read as a defect list.
 */
export function formatReconsiderationOpening(report: ReconsiderationOpenReport): string {
  const lines = [
    `Reconsideration traversed at ${describeBasis(report.basis)}.`,
    `Bounds: at most ${report.basis.bounds.maxDepth} link(s) from the change, ` +
      `${report.basis.bounds.maxItems} item(s).`,
    report.items.length === 0
      ? 'Nothing was reached from this change, so no item was opened.'
      : `Opened ${report.opened}, already retained ${report.retained}.`,
  ];
  for (const [index, entry] of report.items.entries()) {
    lines.push(
      `  ${index + 1}. ${entry.item_id} — ${entry.affected.kind} ${entry.affected.id}` +
        `${entry.retained ? ' (already open; left as it was)' : ''}`,
      `     Why: ${entry.reason}`
    );
    if (entry.owner !== null)
      lines.push(`     Owner: ${entry.owner.name} (${entry.owner.basis}) — ${entry.owner.from}`);
  }
  lines.push(...describeLimits(report.limits, ''));
  lines.push(report.coverage.statement);
  return `${lines.join('\n')}\n`;
}

export function formatReconsiderationList(report: ReconsiderationListReport): string {
  const lines = [
    `Reconsideration items read at ${describeBasis(report.basis)}.`,
    report.items.length === 0
      ? 'Items (0): this read holds none at this boundary.'
      : `Items (${report.items.length})`,
  ];
  for (const [index, item] of report.items.entries()) lines.push(...describeItem(item, index + 1));
  if (report.later > 0)
    lines.push(`${report.later} item(s) were opened after this boundary and are not shown.`);
  if (report.truncated > 0)
    lines.push(`${report.truncated} further item(s) were not carried: raise --limit to see them.`);
  lines.push(report.coverage.statement);
  return `${lines.join('\n')}\n`;
}
