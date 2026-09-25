import {
  type EvaluatorFinding,
  type EvaluatorFindingConclusion,
  type EvaluatorFindingLocation,
  FindingKeySchema,
} from '@orcaops/evaluator-protocol';

/**
 * Builders for the structured findings an evaluator may attach to its
 * result. They exist so an author never hand-writes the location union or
 * guesses at what a key may contain.
 *
 * The division of labour is the protocol's: the schema REFUSES what is
 * incoherent and never rewrites it, because the producer's payload is
 * retained beside the finding and a silently normalised record would differ
 * from what the producer emitted. Normalising for the author therefore
 * happens here, in the author's own process, before the value is written.
 *
 * There is no builder for the `requirement` and `decision` locations: no
 * field of today's `EvaluatorContext` carries a requirement or decision
 * revision id, so no producer can populate one yet. They are in the
 * protocol's union because the shape is fixed; a helper would only invite an
 * author to invent an id.
 */

export interface FindingInput {
  /**
   * The statement, as one line. Line breaks are folded to spaces here: a
   * title is rendered as one line by every consumer, the protocol refuses
   * every character that ends a line somewhere, and an author building a
   * title out of captured text should not have their run fail over a
   * newline in someone else's prose.
   */
  title: string;
  /** Elaboration, quotes, reasoning. */
  detail?: string;
  /**
   * Recurrence key. Set it only when a later run of this evaluator can name
   * the same thing the same way; {@link findingKey} builds one safely.
   */
  key?: string;
  /** What the finding points at. Omit it when it points at nothing. */
  locations?: readonly EvaluatorFindingLocation[];
  /** Requires at least one expectation location; the protocol refuses it otherwise. */
  conclusion?: EvaluatorFindingConclusion;
}

export function finding(input: FindingInput): EvaluatorFinding {
  return {
    ...(input.key !== undefined ? { key: input.key } : {}),
    title: singleLine(input.title),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(input.locations !== undefined ? { locations: [...input.locations] } : {}),
    ...(input.conclusion !== undefined ? { conclusion: input.conclusion } : {}),
  };
}

export interface FileLocationOptions {
  /**
   * Absolute repository root — `ctx.repo.root`. Supply it when the path you
   * hold is absolute; the prefix is removed so the location is
   * repository-relative, which is the only form the protocol accepts.
   */
  repoRoot?: string;
  startLine?: number;
  endLine?: number;
  /** A full 40- or 64-character lowercase git object id, or nothing. */
  revision?: string;
}

/** Each builder returns its own kind, not the union, so a caller can read the fields back. */
type LocationOfKind<K extends EvaluatorFindingLocation['kind']> = Extract<
  EvaluatorFindingLocation,
  { kind: K }
>;

export function fileLocation(
  filePath: string,
  options: FileLocationOptions = {}
): LocationOfKind<'file'> {
  return {
    kind: 'file',
    path: repositoryRelativePath(filePath, options.repoRoot),
    ...(options.startLine !== undefined ? { start_line: options.startLine } : {}),
    ...(options.endLine !== undefined ? { end_line: options.endLine } : {}),
    ...(options.revision !== undefined ? { revision: options.revision } : {}),
  };
}

export function planStepLocation(stepId: string): LocationOfKind<'plan-step'> {
  return { kind: 'plan-step', step_id: stepId };
}

export function acceptanceCriterionLocation(
  criterionId: string
): LocationOfKind<'acceptance-criterion'> {
  return { kind: 'acceptance-criterion', criterion_id: criterionId };
}

/**
 * Join `segments` into a recurrence key, or return `undefined` when they do
 * not form one the protocol accepts.
 *
 * A key built from a path, a tag or a rule id is the intended use, and a
 * repository is free to contain a file name with a space or an accent that no
 * key may carry. Returning `undefined` costs that finding its cross-run
 * identity, which is exactly what an absent key means; refusing at write time
 * instead would cost the author's whole run over a file name.
 *
 * It never sanitises: a key with characters removed would name something
 * other than what the producer meant, and storage matches it byte for byte.
 */
export function findingKey(...segments: readonly string[]): string | undefined {
  // Each segment is checked on its own as well as joined: an absolute path is
  // refused as a key, and `findingKey('removed', '/etc/a')` must not smuggle
  // one in behind a prefix that makes the join look well formed.
  if (segments.some((segment) => !FindingKeySchema.safeParse(segment).success)) return undefined;
  const candidate = segments.join('/');
  return FindingKeySchema.safeParse(candidate).success ? candidate : undefined;
}

/**
 * Every code point the protocol refuses in a `title`, folded to a space:
 * CR, LF, NUL, VT, FF, NEL and the Unicode line/paragraph separators.
 */
const LINE_BREAKS_IN_TITLE = /[\0\n\v\f\r\u0085\u2028\u2029]+/gu;

function singleLine(title: string): string {
  return title.replace(LINE_BREAKS_IN_TITLE, ' ').trim();
}

function repositoryRelativePath(filePath: string, repoRoot?: string): string {
  let value = filePath.replace(/\\/g, '/');
  if (repoRoot !== undefined) {
    const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (root.length > 0 && value.startsWith(`${root}/`)) value = value.slice(root.length + 1);
  }
  return value.replace(/^(?:\.\/)+/, '');
}
