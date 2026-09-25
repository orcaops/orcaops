// The change a caller asked about, and the bounds the walk runs under.
//
// `knowledge consequences` and `knowledge reconsider open` ask the same question of the same
// history and differ only in what they do with the answer, so they parse one set of flags here
// rather than two that could drift apart: a change either verb accepts is one the other accepts,
// with the same refusals in the same words.
import type { ConsequenceBounds, ConsequenceChange, ConsequenceLimit } from '@orcaops/core';
import type { KnowledgeTarget } from '@orcaops/storage';
import {
  type knowledgeReadRequest,
  type ProjectReadView,
  readProjectStandingMovedSince,
} from '@orcaops/storage/history/database';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';

export const DEFAULT_CONSEQUENCE_DEPTH = 3;
export const MAX_CONSEQUENCE_DEPTH = 10;
export const DEFAULT_CONSEQUENCE_LIMIT = 25;
export const MAX_CONSEQUENCE_LIMIT = 200;
/**
 * How many whole paths one item keeps. Three is enough to show that an item is reached more than
 * one way without turning a dense graph's answer into a list of routes.
 */
export const CONSEQUENCE_PATHS_PER_ITEM = 3;

const IDENTITY_KINDS = new Set(['requirement', 'decision', 'claim']);

export interface ConsequenceChangeOptions {
  identity?: string;
  revision?: string;
  touching?: string;
  since?: string;
  atBoundary?: string;
  depth?: string;
  limit?: string;
}

export function consequenceIdentityOf(value: string, flag: string): KnowledgeTarget {
  const at = value.indexOf(':');
  const kind = at < 0 ? '' : value.slice(0, at);
  const entityId = at < 0 ? '' : value.slice(at + 1);
  if (!IDENTITY_KINDS.has(kind) || entityId.length === 0)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `${flag} names an identity as <kind>:<id>, where kind is one of ` +
        `${[...IDENTITY_KINDS].sort().join(', ')}`,
      flag.replace(/^--/u, '')
    );
  return { kind: kind as KnowledgeTarget['kind'], entity_id: entityId };
}

export function boundedNumber(
  value: string,
  bounds: { min: number; max: number },
  flag: string
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `${flag} takes a whole number between ${bounds.min} and ${bounds.max}`,
      flag.replace(/^--/u, '')
    );
  return parsed;
}

export type AskedChange =
  | { kind: 'change'; change: ConsequenceChange }
  | { kind: 'since'; boundary: number };

export function askedChange(opts: ConsequenceChangeOptions): AskedChange {
  const named = [
    opts.identity === undefined ? null : 'identity',
    opts.revision === undefined ? null : 'revision',
    opts.touching === undefined ? null : 'touching',
    opts.since === undefined ? null : 'since',
  ].filter((value) => value !== null);
  if (named.length !== 1)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      'Ask about one change: `--identity <kind>:<id>`, `--revision <kind>:<id>@<revision>`, ' +
        '`--touching <path>`, or `--since <write sequence>`',
      'identity'
    );
  if (opts.identity !== undefined)
    return {
      kind: 'change',
      change: {
        kind: 'revision',
        identity: consequenceIdentityOf(opts.identity, '--identity'),
        // The caller named an identity and no revision of it, so nothing here decides which
        // revision moved: every recorded use of the identity is reached and each path says which
        // revision it names.
        revision_id: null,
        moved: 'unstated',
      },
    };
  if (opts.revision !== undefined) {
    const at = opts.revision.lastIndexOf('@');
    const revisionId = at < 0 ? '' : opts.revision.slice(at + 1);
    if (revisionId.length === 0)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--revision names an exact revision as <kind>:<id>@<revision>',
        'revision'
      );
    return {
      kind: 'change',
      change: {
        kind: 'revision',
        identity: consequenceIdentityOf(opts.revision.slice(0, at), '--revision'),
        revision_id: revisionId,
        moved: 'unstated',
      },
    };
  }
  if (opts.touching !== undefined) {
    if (opts.touching.trim().length === 0)
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        '--touching takes a repository path or a glob over one',
        'touching'
      );
    return { kind: 'change', change: { kind: 'implementation', paths: [opts.touching] } };
  }
  return {
    kind: 'since',
    boundary: boundedNumber(
      opts.since as string,
      { min: 0, max: Number.MAX_SAFE_INTEGER },
      '--since'
    ),
  };
}

export function consequenceBounds(opts: ConsequenceChangeOptions): ConsequenceBounds {
  return {
    maxDepth:
      opts.depth === undefined
        ? DEFAULT_CONSEQUENCE_DEPTH
        : boundedNumber(opts.depth, { min: 1, max: MAX_CONSEQUENCE_DEPTH }, '--depth'),
    maxItems:
      opts.limit === undefined
        ? DEFAULT_CONSEQUENCE_LIMIT
        : boundedNumber(opts.limit, { min: 1, max: MAX_CONSEQUENCE_LIMIT }, '--limit'),
    maxPathsPerItem: CONSEQUENCE_PATHS_PER_ITEM,
  };
}

export function knowledgeBoundaryAsked(value: string | undefined, flag = '--at-boundary') {
  return value === undefined
    ? ('now' as const)
    : boundedNumber(value, { min: 0, max: Number.MAX_SAFE_INTEGER }, flag);
}

const MOVEMENT = {
  adoption: 'adopted',
  correction: 'corrected',
  replacement: 'replaced',
} as const;

/** One change for a named identity, revision or path; one per revision an act moved for `--since`. */
export function consequenceChangesOf(
  view: ProjectReadView,
  asked: AskedChange,
  request: ReturnType<typeof knowledgeReadRequest>,
  bounds: ConsequenceBounds
): { changes: ConsequenceChange[]; limits: ConsequenceLimit[] } {
  if (asked.kind === 'change') return { changes: [asked.change], limits: [] };
  const moved = readProjectStandingMovedSince(view, asked.boundary, request, {
    maxMoves: bounds.maxItems,
  });
  return {
    changes: moved.moves.map((move) => ({
      kind: 'revision',
      identity: { kind: move.revision.kind, entity_id: move.revision.entity_id },
      revision_id: move.revision.revision_id,
      moved: MOVEMENT[move.because],
    })),
    limits: [
      ...moved.limits,
      ...(moved.moves.length === 0
        ? [
            {
              kind: 'nothing_moved',
              detail:
                `No act after write sequence ${asked.boundary} moved a revision's recorded ` +
                `standing, up to write sequence ${request.knowledge_boundary}. That is what ` +
                `this history holds, not a statement that nothing changed.`,
            },
          ]
        : []),
    ],
  };
}
