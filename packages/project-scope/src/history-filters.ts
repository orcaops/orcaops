import path from 'node:path';

import { isValidGlobSyntax } from '@orcaops/evaluator-protocol';

import { HistoryScopeError } from './history-types.js';

export type HistoryOriginFilter = 'all' | 'captured' | 'imported';
export interface HistoryFilters {
  origin?: HistoryOriginFilter;
  touching?: string;
  state?: 'planned' | 'active' | 'blocked' | 'summarized';
  since?: string;
  until?: string;
  activeSince?: string;
  activeUntil?: string;
  limit?: number;
  offset?: number;
}

export function parseHistoryTime(
  raw: string | undefined,
  edge: 'lower' | 'upper'
): string | undefined {
  if (raw === undefined) return undefined;
  const fail = () =>
    new HistoryScopeError(
      'INVALID_INPUT',
      'Time filters require an ISO date or datetime interpreted as UTC'
    );
  let candidate: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw))
    candidate = raw + (edge === 'lower' ? 'T00:00:00.000Z' : 'T23:59:59.999Z');
  else if (/^\d{4}-\d{2}-\d{2}T/.test(raw))
    candidate = /(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : raw + 'Z';
  else throw fail();
  const parsed = new Date(candidate);
  if (
    Number.isNaN(parsed.getTime()) ||
    (candidate.endsWith('Z') && parsed.toISOString().slice(0, 10) !== candidate.slice(0, 10))
  )
    throw fail();
  return parsed.toISOString();
}

export function normalizeHistoryFilters(
  input: HistoryFilters = {}
): HistoryFilters & { origin: HistoryOriginFilter; offset: number } {
  if (input.origin !== undefined && !['all', 'captured', 'imported'].includes(input.origin))
    throw new HistoryScopeError('INVALID_INPUT', 'Origin must be all, captured or imported');
  if (
    input.state !== undefined &&
    !['planned', 'active', 'blocked', 'summarized'].includes(input.state)
  )
    throw new HistoryScopeError('INVALID_INPUT', 'Unknown artifact state');
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit <= 0))
    throw new HistoryScopeError('INVALID_INPUT', 'Limit must be a positive integer');
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0))
    throw new HistoryScopeError('INVALID_INPUT', 'Offset must be a nonnegative integer');
  if (input.touching !== undefined) {
    const normalized = input.touching.replace(/\\/g, '/');
    if (
      !input.touching.trim() ||
      path.posix.isAbsolute(normalized) ||
      path.win32.isAbsolute(input.touching) ||
      normalized.split('/').includes('..') ||
      !isValidGlobSyntax(input.touching)
    )
      throw new HistoryScopeError(
        'INVALID_INPUT',
        'Touching requires a valid project-relative glob without parent traversal'
      );
  }
  const result = {
    ...input,
    origin: input.origin ?? 'all',
    offset: input.offset ?? 0,
    since: parseHistoryTime(input.since, 'lower'),
    until: parseHistoryTime(input.until, 'upper'),
    activeSince: parseHistoryTime(input.activeSince, 'lower'),
    activeUntil: parseHistoryTime(input.activeUntil, 'upper'),
  };
  for (const [lower, upper] of [
    [result.since, result.until],
    [result.activeSince, result.activeUntil],
  ])
    if (lower !== undefined && upper !== undefined && lower > upper)
      throw new HistoryScopeError('INVALID_INPUT', 'History time window is inverted');
  return result;
}
