// The continuing knowledge a read surface puts beside the thread it already renders.
//
// `show`, `resume`, `digest` and `why` all print a thread's own captures and used to say nothing
// about the rules that thread is answerable to. Each now reads the shared answer — composed in the
// surface's own snapshot, shaped once in core — so none of them decides standing, applicability or
// which correction is current, and none can print a different one for the same identity.
import { interpretationLines, knowledgeBlock, type KnowledgeBlock } from '@orcaops/core';
import type { KnowledgeBoundary, ProjectKnowledgeContext } from '@orcaops/storage/history/database';

import type { ArtifactKnowledgeUses } from './plan-knowledge-uses.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/** A write sequence as it is typed: digits and nothing else. */
const WRITE_SEQUENCE = /^\d+$/u;

/**
 * The one `--at-boundary <n>` parser every surface that offers the flag uses. Some commands parse
 * the flag at the command line and hand over a number, others hand over the raw string, and three
 * separate readings of it disagreed about what a boundary is.
 *
 * A boundary is a write sequence of this store, so anything else is refused here rather than read
 * as `now`: an answer that quietly answered a different question than the one asked is the whole
 * failure this flag exists to avoid. A boundary past the store's committed sequence is refused by
 * the read request itself.
 *
 * Matched by pattern rather than handed to `Number()`, because `Number('')` is 0 and
 * `Number('1e3')` is 1000 — an empty flag and an exponent would both read as a boundary nobody
 * typed, and the answer at it would look like an ordinary one.
 */
export function knowledgeBoundaryOption(raw: unknown, flag = '--at-boundary'): KnowledgeBoundary {
  if (raw === undefined) return 'now';
  const parsed = typeof raw === 'string' && WRITE_SEQUENCE.test(raw) ? Number(raw) : raw;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `${flag} takes a write sequence of this project history: a whole number no smaller than zero`,
      'at-boundary'
    );
  return parsed;
}

/** The newest plan event of the thread, which is the plan an unselected-rules diff is against. */
export function planInView(
  artifactId: string,
  uses: ArtifactKnowledgeUses
): { artifactId: string; planEventId: string } | null {
  const planEventId = uses.plan_events.at(-1)?.plan_event_id;
  return planEventId === undefined ? null : { artifactId, planEventId };
}

/**
 * The block, from the answer the surface's own snapshot composed. The processing coverage is not
 * read here: these surfaces resolve no provider and load no consent grant, so the block claims no
 * completeness and says so — `orcaops knowledge status` is where that claim is made.
 */
export function artifactKnowledgeBlock(input: {
  context: ProjectKnowledgeContext;
  /** Null when no plan is in view; the diff then says so rather than returning an empty list. */
  plan: { artifactId: string; planEventId: string } | null;
}): KnowledgeBlock {
  return knowledgeBlock(input.context, { plan: input.plan });
}

const quoted = (statement: string | null) => (statement === null ? null : `"${statement}"`);

function entryLines(block: KnowledgeBlock, keys: readonly string[], indent: string): string[] {
  const byKey = new Map(block.entries.map((entry) => [entry.key, entry]));
  const lines: string[] = [];
  for (const key of keys) {
    const entry = byKey.get(key);
    if (entry === undefined) continue;
    lines.push(
      `${indent}- ${entry.key} — ` +
        (entry.governing_revision_ids.length === 0
          ? 'no revision of it governs here'
          : `governing revision(s) ${entry.governing_revision_ids.join(', ')}`)
    );
    const statement = quoted(entry.statement);
    if (statement !== null) lines.push(`${indent}    ${statement}`);
    if (entry.rationale !== undefined)
      lines.push(
        `${indent}    Reason: ${entry.rationale === null ? 'unknown (not supplied)' : JSON.stringify(entry.rationale)}`
      );
    lines.push(`${indent}    ${entry.reason}`);
    if (entry.selected_with_plan.length > 0 || entry.connected_later.length > 0)
      lines.push(
        `${indent}    Task uses: ${entry.selected_with_plan.length} selected with the plan, ` +
          `${entry.connected_later.length} connected later`
      );
  }
  return lines;
}

/**
 * The block as a person reads it. The boundary leads, because every line under it is an answer at
 * that boundary and nothing else; the coverage closes it, so an answer with no entries is never
 * read as "there are no rules" when it is really "nothing here has been interpreted".
 */
export function renderKnowledgeBlock(block: KnowledgeBlock, indent = ''): string[] {
  const { basis } = block;
  const scope =
    basis.scope.kind === 'project'
      ? `project ${basis.scope.project_id}`
      : `artifact ${basis.scope.artifact_id}`;
  const lines = [
    `${indent}Knowledge read at write sequence ${basis.knowledge_boundary} (${basis.mode}), ${scope}.`,
  ];
  lines.push(
    block.applicable.length === 0
      ? `${indent}  Applicable (0): no adopted rule of this read applies here.`
      : `${indent}  Applicable (${block.applicable.length})`
  );
  lines.push(...entryLines(block, block.applicable, `${indent}  `));
  const missed = block.applicable_not_selected;
  lines.push(
    `${indent}  Applicable and not selected (${missed.entries.length}): ${missed.statement}`
  );
  for (const entry of missed.entries)
    lines.push(`${indent}    - ${entry.key}: revision(s) ${entry.revision_ids.join(', ')}`);
  lines.push(
    block.background.length === 0
      ? `${indent}  Background (0): nothing else was found.`
      : `${indent}  Background (${block.background.length})`
  );
  lines.push(...entryLines(block, block.background, `${indent}  `));
  for (const interpretation of block.interpretations ?? [])
    lines.push(...interpretationLines(interpretation, `${indent}  `));
  // A correction dated after the boundary is named, never merged into the body above: an
  // historical answer that quietly carried a later correction would not be an historical answer.
  if (block.later_annotations.length > 0) {
    lines.push(`${indent}  Recorded after this boundary (${block.later_annotations.length})`);
    for (const later of block.later_annotations)
      lines.push(
        `${indent}    - ${later.record} ${later.record_id} at write sequence ${later.write_sequence}` +
          (later.correction === null ? '' : ` (${later.correction.kind})`)
      );
  }
  lines.push(`${indent}  Coverage: ${block.coverage.statement}`);
  for (const limit of block.limits) lines.push(`${indent}  Limit: ${limit.detail}`);
  return lines;
}

/**
 * The same block as a digest section. The lines are indented rather than bulleted: they nest, and
 * a reviewer reading the rendered digest needs the nesting to tell a rule from its wording.
 */
export function knowledgeDigestSection(block: KnowledgeBlock): string {
  return ['## continuing knowledge', '', '```', ...renderKnowledgeBlock(block), '```', ''].join(
    '\n'
  );
}
