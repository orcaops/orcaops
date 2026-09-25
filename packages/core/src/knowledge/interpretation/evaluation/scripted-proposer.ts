import type { InterpretationManifest } from '../manifest.js';
import type {
  LinkRelation,
  ProposedCitation,
  ProposedRecordKind,
  SourceForm,
} from '../proposal.js';
import { PROPOSAL_SCHEMA_VERSION } from '../versions.js';
import type { Proposer, ProposerAnswer } from './harness.js';

export interface ScriptedStatement {
  quote: string;
  nth?: number;
  source_form: SourceForm;
  proposed_record: ProposedRecordKind | 'finding';
  scope?: 'artifact' | 'project';
  rationale?: string;
  links?: readonly { ref: string; relation: LinkRelation | 'restates' }[];
  unknown_segment?: true;
  invented_quote?: string;
  explicit?: ProposedCitation | { start: number; end: number; quote: string };
}

export interface ScriptedCorrection {
  kind: 'challenge' | 'factual_correction';
  ref: string;
  account: string;
}

export interface Script {
  statements?: readonly ScriptedStatement[];
  corrections?: readonly ScriptedCorrection[];
  uncertainties?: readonly {
    about: 'source' | 'statement' | 'link' | 'meaning' | 'scope' | 'equivalence';
    statement_index: number | null;
    note: string;
  }[];
  manifest_sha256?: string;
  proposal_schema_version?: string;
  extra?: Record<string, unknown>;
}

export function scriptedProposer(scripts: Readonly<Record<string, Script>>): Proposer {
  return (request) => Promise.resolve(answerFor(request.manifest, scripts));
}

function answerFor(
  manifest: InterpretationManifest,
  scripts: Readonly<Record<string, Script>>
): ProposerAnswer {
  const sourceId = manifest.sources[0]?.source_id;
  const script = sourceId === undefined ? undefined : scripts[sourceId];
  if (script === undefined) {
    return {
      status: 'failed',
      code: 'NO_SCRIPT',
      message: `no scripted answer for ${sourceId ?? '<no source>'}`,
    };
  }
  const body = {
    proposal_schema_version: script.proposal_schema_version ?? PROPOSAL_SCHEMA_VERSION,
    manifest_sha256: script.manifest_sha256 ?? manifest.manifest_sha256,
    statements: (script.statements ?? []).map((statement) => {
      const citation = citationFor(manifest, statement);
      const identityLink = statement.links?.find((link) =>
        ['restates', 'exact_restatement', 'equivalent_to'].includes(link.relation)
      );
      const targetEntry =
        identityLink === undefined
          ? undefined
          : manifest.revisions.find((entry) => entry.ref === identityLink.ref);
      const targetScope =
        targetEntry?.intended_scope ??
        (targetEntry?.intended_scope_status === 'legacy_absent'
          ? (targetEntry.adopted_scope ?? undefined)
          : undefined);
      return {
        source_ref: citation.source_ref,
        wording: statement.quote,
        source_form: statement.source_form,
        proposed_record:
          statement.proposed_record === 'finding' ? 'claim' : statement.proposed_record,
        intended_scope:
          statement.scope === 'project'
            ? { kind: 'project' }
            : targetScope?.kind === 'project'
              ? { kind: 'project' }
              : targetScope?.kind === 'unknown'
                ? { kind: 'unknown' }
                : { kind: 'current_task' },
        evidence: [citation],
        rationale:
          statement.rationale === undefined
            ? { kind: 'unknown' }
            : {
                kind: 'stated',
                wording: statement.rationale,
                citations: [citationFor(manifest, { ...statement, quote: statement.rationale })],
              },
        alternatives: [],
        links: (statement.links ?? []).map((link) => ({
          revision_ref: link.ref,
          relation: link.relation === 'restates' ? 'exact_restatement' : link.relation,
        })),
      };
    }),
    corrections: (script.corrections ?? []).map((correction) => ({
      kind: correction.kind,
      revision_ref: correction.ref,
      account: citationFor(manifest, { quote: correction.account }),
    })),
    uncertainties: (script.uncertainties ?? []).map((uncertainty) => ({
      ...uncertainty,
      about:
        uncertainty.about === 'link'
          ? 'equivalence'
          : uncertainty.about === 'source' || uncertainty.about === 'statement'
            ? 'meaning'
            : uncertainty.about,
    })),
    ...(script.extra ?? {}),
  };
  return { status: 'answered', body: JSON.stringify(body) };
}

function citationFor(
  manifest: InterpretationManifest,
  statement: Pick<ScriptedStatement, 'quote' | 'unknown_segment' | 'invented_quote' | 'explicit'>
): ProposedCitation {
  if (statement.explicit !== undefined && 'source_ref' in statement.explicit) {
    return statement.explicit;
  }
  const segment = manifest.segments.find((candidate) => candidate.text.includes(statement.quote));
  if (segment === undefined) {
    return {
      source_ref: manifest.sources[0]?.ref ?? 's1',
      segment_ref: manifest.segments[0]?.ref ?? 'g1',
      quote: statement.invented_quote ?? statement.quote,
    };
  }
  return {
    source_ref: segment.source_ref,
    segment_ref: statement.unknown_segment === undefined ? segment.ref : 'g999999',
    quote:
      statement.invented_quote ??
      (statement.explicit !== undefined && 'quote' in statement.explicit
        ? statement.explicit.quote
        : statement.quote),
  };
}
