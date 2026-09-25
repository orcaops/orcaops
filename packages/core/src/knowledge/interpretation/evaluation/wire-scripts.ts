import type { EvaluationCase } from './harness.js';
import type { Script, ScriptedStatement } from './scripted-proposer.js';
import { SCRIPTED_ANSWERS } from './scripts.js';
import type { LinkRelation } from '../proposal.js';

/**
 * The scripted answers in a form a provider can replay from the request alone.
 *
 * `scripted-proposer.ts` resolves a manifest ref (`k1r1`) against the manifest object it holds. A
 * provider holds no manifest: it has the rendered request, where a retrieved revision appears
 * under a ref the run decided and beside its wording. So a link is carried here by that wording,
 * which is the one thing both sides can agree on, and the provider resolves it back to whatever
 * ref this run gave it. A ref no manifest holds has no wording to carry, so it is kept as itself.
 *
 * The translation is mechanical, from the cases and the scripts, so the two forms cannot say
 * different things.
 */

export interface WireLink {
  /** The wording of the revision this link names, as the request's related-knowledge block gives it. */
  statement?: string;
  /** A ref to send whatever the request carries, for the case that names one no manifest holds. */
  ref?: string;
  relation: LinkRelation;
}

export type WireIntendedScope =
  | { kind: 'project' }
  | { kind: 'current_task' }
  | { kind: 'unknown' };

export interface WireStatement {
  quote: string;
  /** Which occurrence of `quote` to cite. 1 by default. */
  nth?: number;
  source_form: ScriptedStatement['source_form'];
  proposed_record: Exclude<ScriptedStatement['proposed_record'], 'finding'>;
  intended_scope: WireIntendedScope;
  rationale?: string;
  alternatives: readonly [];
  links?: readonly WireLink[];
  citation_fault?: 'unknown_segment' | 'outside_unit';
  invented_quote?: string;
}

export interface WireCorrection {
  kind: 'challenge' | 'factual_correction';
  statement?: string;
  ref?: string;
  account: string;
}

export interface WireScript {
  statements?: readonly WireStatement[];
  corrections?: readonly WireCorrection[];
  uncertainties?: Script['uncertainties'];
  manifest_sha256?: string;
  proposal_schema_version?: string;
  extra?: Record<string, unknown>;
  /**
   * The fixture unit this answer belongs to. A real-worker measurement remaps it to the unit built
   * from the same original synthetic source before handing the script to its fake provider.
   */
  only_unit?: string;
}

const statementOf = (evaluated: EvaluationCase, ref: string): string | null =>
  evaluated.manifest.revisions.find((entry) => entry.ref === ref)?.statement ?? null;

function wireLink(evaluated: EvaluationCase, ref: string, relation: LinkRelation | 'restates') {
  const statement = statementOf(evaluated, ref);
  const normalized = relation === 'restates' ? 'exact_restatement' : relation;
  return statement === null ? { ref, relation: normalized } : { statement, relation: normalized };
}

function intendedScope(evaluated: EvaluationCase, statement: ScriptedStatement): WireIntendedScope {
  if (statement.scope === 'project') return { kind: 'project' };
  const identity = statement.links?.find((link) =>
    ['restates', 'exact_restatement', 'equivalent_to'].includes(link.relation)
  );
  const target =
    identity === undefined
      ? undefined
      : evaluated.manifest.revisions.find((entry) => entry.ref === identity.ref);
  const targetScope =
    target?.intended_scope ??
    (target?.intended_scope_status === 'legacy_absent' ? target.adopted_scope : null);
  if (targetScope?.kind === 'project') return { kind: 'project' };
  if (targetScope?.kind === 'unknown') return { kind: 'unknown' };
  return { kind: 'current_task' };
}

export function wireScript(evaluated: EvaluationCase, script: Script): WireScript {
  const segment = evaluated.manifest.segments[0];
  const preparedBytes = segment.mapping.at(-1)?.prepared.end ?? segment.prepared_range.end;
  const partial =
    segment.prepared_range.start !== 0 || segment.prepared_range.end !== preparedBytes;
  if (partial && segment.prepared_range.start !== 0) {
    throw new Error(`${evaluated.name} carries a chunk that does not start the source`);
  }
  return {
    ...(script.manifest_sha256 === undefined ? {} : { manifest_sha256: script.manifest_sha256 }),
    ...(script.proposal_schema_version === undefined
      ? {}
      : { proposal_schema_version: script.proposal_schema_version }),
    ...(script.extra === undefined ? {} : { extra: script.extra }),
    ...(script.uncertainties === undefined ? {} : { uncertainties: script.uncertainties }),
    ...(!partial ? {} : { only_unit: evaluated.manifest.unit_id }),
    statements: (script.statements ?? []).map((statement) => ({
      quote: statement.quote,
      ...(statement.nth === undefined ? {} : { nth: statement.nth }),
      source_form: statement.source_form,
      proposed_record:
        statement.proposed_record === 'finding' ? 'claim' : statement.proposed_record,
      intended_scope: intendedScope(evaluated, statement),
      ...(statement.rationale === undefined ? {} : { rationale: statement.rationale }),
      ...(statement.unknown_segment === undefined
        ? {}
        : { citation_fault: 'unknown_segment' as const }),
      ...(statement.invented_quote === undefined
        ? {}
        : { invented_quote: statement.invented_quote }),
      ...(statement.explicit === undefined ? {} : { citation_fault: 'outside_unit' as const }),
      alternatives: [],
      links: (statement.links ?? []).map((link) => wireLink(evaluated, link.ref, link.relation)),
    })),
    corrections: (script.corrections ?? []).map((correction) => {
      const statement = statementOf(evaluated, correction.ref);
      return {
        kind: correction.kind,
        ...(statement === null ? { ref: correction.ref } : { statement }),
        account: correction.account,
      };
    }),
  };
}

/** Every case's scripted answer, keyed by the source id the fixed set gives it. */
export function wireScriptsFor(
  cases: readonly EvaluationCase[],
  scripts: Readonly<Record<string, Script>> = SCRIPTED_ANSWERS
): Record<string, WireScript> {
  const wired: Record<string, WireScript> = {};
  for (const evaluated of cases) {
    const sourceId = evaluated.manifest.sources[0]?.source_id;
    const script = sourceId === undefined ? undefined : scripts[sourceId];
    if (script !== undefined) wired[sourceId] = wireScript(evaluated, script);
  }
  return wired;
}
