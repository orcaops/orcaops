import { knowledgeContextAnswer, type KnowledgeContextEntry } from '@orcaops/core';
import {
  rationaleAccountText,
  rationaleChangePassage,
  rationaleLexicalSupport,
  rationaleTargetMatch,
  type readProjectRationale,
} from '@orcaops/storage/history/database';

import { groupExplanations } from './provenance-explanation-groups.js';
import { textPreview } from './provenance-output.js';

type Reading = ReturnType<typeof readProjectRationale>['value'];
type Account = Pick<Reading['items'][number]['account'], 'wording' | 'reason'> & {
  alternatives?: Reading['items'][number]['account']['alternatives'];
};
type Record = Reading['records'][number];

function relevantRevisions(entry: KnowledgeContextEntry) {
  const required = new Set([
    ...entry.resolved.conflicts.flatMap((conflict) =>
      conflict.revisions.map((revision) => revision.revision_id)
    ),
    ...entry.resolved.relationships.flatMap((relationship) => [
      relationship.from.revision_id,
      relationship.to.revision_id,
    ]),
    ...entry.references.flatMap((reference) => reference.revisionIds),
  ]);
  return entry.revisions.filter(
    (revision) =>
      revision.is_tip ||
      (revision.standing === 'adopted' && revision.applicability !== 'does_not_apply') ||
      required.has(revision.revision.revision_id)
  );
}

export function focusedKnowledge(entry: KnowledgeContextEntry, record: Record | undefined) {
  return {
    id: entry.key,
    kind: entry.target.kind,
    placement: entry.placement,
    explanation: entry.reason,
    accounts: relevantRevisions(entry).map((revision) => ({
      revision_id: revision.revision.revision_id,
      statement: revision.statement,
      reason: revision.rationale ?? null,
      standing: revision.standing,
      applicability: revision.applicability,
      scopes: entry.resolved.revisions
        .filter((held) => held.revision.revision_id === revision.revision.revision_id)
        .map((held) => ({
          scope: held.scope,
          standing: held.standing,
          designation: held.designation,
          applicability: held.applicability,
        })),
    })),
    ...(entry.resolved.conflicts.length ? { conflicts: entry.resolved.conflicts } : {}),
    ...(entry.resolved.omissions.length ? { limitations: entry.resolved.omissions } : {}),
    ...(entry.resolved.unresolved.length ? { unresolved: entry.resolved.unresolved } : {}),
    ...(record?.corrections.length ? { corrections: record.corrections } : {}),
    ...(record?.omitted_corrections ? { omitted_corrections: record.omitted_corrections } : {}),
    reference: record?.reference ?? null,
    sources: entry.references.map((source) => ({
      artifact_id: source.artifactId,
      event_id: source.eventId,
      source_id: source.sourceId,
    })),
  };
}

type FocusedRecord = ReturnType<typeof focusedKnowledge>;
export type FocusedKnowledge = Omit<FocusedRecord, 'accounts' | 'explanation' | 'sources'> & {
  qualification?: Pick<
    FocusedRecord['accounts'][number],
    'revision_id' | 'standing' | 'applicability' | 'scopes'
  > & { wording_from?: string; reason_from?: string };
  explanation?: FocusedRecord['explanation'];
  sources?: FocusedRecord['sources'];
  accounts: Array<
    Omit<FocusedRecord['accounts'][number], 'statement' | 'reason'> & {
      statement?: string | null;
      reason?: string | null;
      wording_from?: string;
      reason_from?: string;
    }
  >;
};
export interface Explanation {
  id: string;
  kind: string;
  form: 'recorded_capture' | 'unapproved_interpretation' | 'continuing_record';
  account: Account | null;
  source_account?: Account & { reference: string };
  source: { artifact_id: string | null; event_id: string | null; field_path: string | null };
  relevance: {
    basis: string;
    target: ReturnType<typeof rationaleTargetMatch>;
    discovery?: Record['discovery'];
    support?: {
      account_id: string;
      knowledge_id: string;
      target: ReturnType<typeof rationaleTargetMatch>;
    };
  };
  temporal: string;
  authority: string;
  context: FocusedKnowledge[];
  reference: string;
  verification?: true;
  planned_verification?: true;
  interpretations?: Array<{
    id: string;
    kind?: string;
    authority: string;
    account?: Account | null;
    account_from?: string;
    context_ids?: string[];
    relevance?: Explanation['relevance'];
    temporal?: string;
    reference: string;
  }>;
}

export function conciseExplanation(item: Explanation): Explanation {
  return {
    ...item,
    interpretations: item.interpretations?.map((variant) => ({
      ...variant,
      kind: variant.kind === item.kind ? undefined : variant.kind,
      temporal: variant.temporal === item.temporal ? undefined : variant.temporal,
      relevance:
        JSON.stringify(variant.relevance) === JSON.stringify(item.relevance)
          ? undefined
          : variant.relevance,
      context_ids:
        JSON.stringify(variant.context_ids) ===
        JSON.stringify(item.context.map((entry) => entry.id))
          ? undefined
          : variant.context_ids,
    })),
    context: item.context.map((entry) => {
      const account = entry.accounts[0];
      const accounts = [item, ...(item.interpretations ?? [])];
      const wordingFrom =
        account?.wording_from ??
        accounts.find((held) => held.account?.wording === account?.statement)?.id;
      const reasonFrom =
        account?.reason_from ??
        accounts.find((held) => held.account?.reason === account?.reason)?.id;
      if (
        entry.accounts.length !== 1 ||
        (account!.statement != null && !wordingFrom) ||
        (account!.reason != null && !reasonFrom) ||
        entry.accounts[0]!.scopes.length > 1 ||
        entry.conflicts?.length ||
        entry.corrections?.length ||
        entry.omitted_corrections ||
        entry.unresolved?.some(
          (point) => point.about !== 'evidence' || point.reason !== 'evidence_not_attached'
        ) ||
        entry.limitations?.length
      )
        return entry;
      const { explanation: _explanation, sources: _sources, ...context } = entry;
      // Full context remains inspectable; the concise form must not erase differing qualifications.
      return {
        ...context,
        accounts: [],
        qualification: {
          revision_id: account!.revision_id,
          standing: account!.standing,
          applicability: account!.applicability,
          scopes: account!.scopes,
          wording_from: wordingFrom,
          reason_from: reasonFrom,
        },
        reference: null,
      };
    }),
  };
}

const verificationOnly = (text: string) =>
  /\b(passed|succeeded|completed without errors|exit code 0)\b/i.test(text) &&
  /\b(test|tests|eslint|lint|typescript|formatting|build|whitespace)\b/i.test(text) &&
  !/\b(because|therefore|instead|motivated|caused|led to|failed|failure|not|no|never|only|except|partial|skipped|unverified|unknown|incomplete|pending)\b/i.test(
    text
  );

const plannedVerification = (item: Explanation) =>
  item.kind === 'criterion' &&
  /^(?:(?:run|execute)\s+)?(?:pnpm|npm|yarn|bun|pytest|eslint|tsc|lint|typecheck|format(?:ting)?)\b/i.test(
    item.account?.wording ?? ''
  ) &&
  /\b(test|tests|lint|eslint|typecheck|tsc|format|formatting|pytest|build)\b/i.test(
    item.account?.wording ?? ''
  ) &&
  !/\b(passed|succeeded|failed|failure|because|therefore|instead|caused|observed|found|not|no|never|only|except|unless|partial|skipped|unverified|unknown|incomplete|pending)\b/i.test(
    `${item.account?.wording ?? ''} ${item.account?.reason ?? ''}`
  );

function explanationPurpose(item: Explanation) {
  if (item.verification || item.planned_verification) return 5;
  if (item.kind === 'decision') return item.account?.alternatives?.length ? 0 : 1;
  if (item.account?.reason || item.source_account?.reason) return 2;
  return item.kind === 'criterion' ? 3 : 4;
}

export function explanationConnection(item: Explanation) {
  const origins = item.relevance.discovery?.map((path) => path.origin) ?? [];
  if (item.relevance.basis === 'candidate_event' || origins.includes('candidate_event')) return 0;
  if (item.relevance.basis === 'candidate_plan' || origins.includes('candidate_plan')) return 1;
  if (item.relevance.basis === 'lexical_overlap' || origins.includes('lexical_overlap')) return 3;
  return 2;
}

export function explanationMentionsChange(item: Explanation) {
  return Boolean(
    (item.account && rationaleChangePassage(item.account.wording)) ||
    item.interpretations?.some(
      (variant) => variant.account && rationaleChangePassage(variant.account.wording)
    )
  );
}

export function explanationChangeSupport(item: Explanation, seeds: readonly string[]) {
  if (!explanationMentionsChange(item)) return false;
  return [item.account, ...(item.interpretations?.map((variant) => variant.account) ?? [])].some(
    (account) =>
      account?.wording
        .split(/(?:\r?\n|(?<=[.!?])\s+)/u)
        .some(
          (passage) =>
            rationaleChangePassage(passage) &&
            rationaleLexicalSupport(passage, account.reason ?? null, seeds) > 0
        )
  );
}

export function orderExplanations(
  items: Explanation[],
  file?: string,
  sourceAccounts: Explanation[] = items
) {
  const basename =
    file
      ?.replaceAll('\\', '/')
      .split('/')
      .at(-1)
      ?.replace(/\.[^.]+$/, '') ?? '';
  const stem = new Set(rationaleTargetMatch(basename, file).terms);
  const targetStrength = (target: Explanation['relevance']['target']) =>
    target.kind === 'explicit_path'
      ? 0
      : stem.size && [...stem].every((term) => target.terms.includes(term))
        ? 2
        : target.terms.some((term) => stem.has(term))
          ? 3
          : target.terms.length
            ? 4
            : 5;
  const direct = new Map(
    [...items, ...sourceAccounts].map((item) => {
      const wording =
        file && item.account
          ? rationaleTargetMatch(item.account.wording, file)
          : item.relevance.target;
      const rank = Math.min(
        targetStrength(wording),
        Math.max(3, targetStrength(item.relevance.target))
      );
      return [
        item.id,
        { rank, target: targetStrength(wording) === rank ? wording : item.relevance.target },
      ];
    })
  );
  const recorded = sourceAccounts.filter(
    (item) => item.form === 'recorded_capture' && explanationConnection(item) < 2
  );
  const recordedById = new Map(recorded.map((item) => [item.id, item]));
  const supportByIdentity = new Map<string, Explanation>();
  for (const item of [...recorded].sort(
    (a, b) => direct.get(a.id)!.rank - direct.get(b.id)!.rank || a.id.localeCompare(b.id)
  ))
    for (const context of item.context)
      if (!supportByIdentity.has(context.id)) supportByIdentity.set(context.id, item);
  const ranked = items.map((original) => {
    const item = { ...original, relevance: { ...original.relevance } };
    delete item.relevance.support;
    let strength = direct.get(item.id)!.rank;
    const source = recordedById.get(item.id);
    if (source) {
      // Only original recorded connections count; grouped interpretations and inherited support do not.
      for (const shared of source.context) {
        const other = supportByIdentity.get(shared.id)!;
        const match = direct.get(other.id)!;
        if (match.rank >= strength) continue;
        strength = Math.min(1, match.rank);
        item.relevance.support = {
          account_id: other.id,
          knowledge_id: shared.id,
          target: match.target,
        };
      }
    }
    return {
      item,
      key: [
        Number(Boolean(item.verification)),
        Math.max(1, explanationConnection(item)),
        strength < 2 ? strength : 2,
        explanationPurpose(item),
        strength,
        explanationConnection(item),
      ],
    };
  });
  ranked.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i]! - b.key[i]!;
    return a.item.id.localeCompare(b.item.id);
  });
  const tiers = new Map<string, Map<string, Explanation[]>>();
  for (const { item, key } of ranked) {
    const tier = tiers.get(key.join(':')) ?? new Map<string, Explanation[]>();
    const artifact = item.source.artifact_id ?? 'project';
    const group = tier.get(artifact) ?? [];
    group.push(item);
    tier.set(artifact, group);
    tiers.set(key.join(':'), tier);
  }
  return [...tiers.values()].flatMap((tier) => {
    const groups = [...tier.values()];
    return Array.from({ length: Math.max(...groups.map((group) => group.length)) }, (_, position) =>
      groups.flatMap((group) => (group[position] ? [group[position]!] : []))
    ).flat();
  });
}

export function provenanceExplanations(reading: Reading, file: string) {
  const answer = knowledgeContextAnswer(reading.context, null);
  const records = new Map(reading.records.map((record) => [record.key, record]));
  const focused = new Map(
    answer.entries.map((entry) => [entry.key, focusedKnowledge(entry, records.get(entry.key))])
  );
  const linked = new Set(reading.items.flatMap((item) => item.knowledge_keys ?? []));
  const items: Explanation[] = reading.items.map((item) => ({
    id: item.id,
    kind: item.account.kind,
    form: item.form,
    account: {
      wording: item.account.wording,
      reason: item.account.reason,
      alternatives: item.account.alternatives,
    },
    ...(item.source_account
      ? {
          source_account: {
            wording: item.source_account.wording,
            reason: item.source_account.reason,
            alternatives: item.source_account.alternatives,
            reference: item.source_account.reference,
          },
        }
      : {}),
    source: item.source,
    relevance: {
      basis: item.relevance,
      target: item.target_match ?? rationaleTargetMatch(item.account.wording, file),
    },
    temporal: item.temporal,
    authority:
      item.form === 'unapproved_interpretation' ? 'unapproved_interpretation' : 'recorded_account',
    context: (item.knowledge_keys ?? []).flatMap((key) =>
      focused.has(key) ? [focused.get(key)!] : []
    ),
    reference: item.reference,
    ...(item.account.kind !== 'decision' &&
    item.source_account?.kind !== 'decision' &&
    verificationOnly(
      `${item.account.wording} ${item.account.reason ?? ''} ${item.source_account?.wording ?? ''} ${item.source_account?.reason ?? ''}`
    )
      ? { verification: true as const }
      : {}),
  }));
  for (const entry of answer.entries) {
    if (entry.placement === 'applicable' || linked.has(entry.key)) continue;
    const context = focused.get(entry.key)!;
    const only = context.accounts.length === 1 ? context.accounts[0]! : null;
    const text = context.accounts
      .map((account) => `${account.statement ?? ''} ${account.reason ?? ''}`)
      .join(' ');
    items.push({
      id: entry.key,
      kind: entry.target.kind,
      form: 'continuing_record',
      account: only
        ? {
            wording: only.statement ?? 'Wording unavailable',
            reason: only.reason,
          }
        : null,
      source: {
        artifact_id: entry.references[0]?.artifactId ?? null,
        event_id: entry.references[0]?.eventId ?? null,
        field_path: null,
      },
      relevance: {
        basis: entry.routes.join(', '),
        target: rationaleTargetMatch(text, file),
        discovery: records.get(entry.key)?.discovery ?? [],
      },
      temporal: 'historical_body',
      authority: entry.placement,
      context: [context],
      reference: context.reference ?? '',
      ...(entry.target.kind === 'claim' && verificationOnly(text)
        ? { verification: true as const }
        : {}),
    });
  }
  for (const item of items) {
    if (!item.verification && plannedVerification(item)) item.planned_verification = true;
    if (
      item.context.length > 1 ||
      item.context.some(
        (entry) =>
          entry.accounts.length > 1 ||
          entry.accounts.some((account) => account.scopes.length > 1) ||
          entry.corrections?.length ||
          entry.omitted_corrections ||
          entry.conflicts?.length ||
          entry.limitations?.length ||
          entry.unresolved?.some(
            (point) => point.about !== 'evidence' || point.reason !== 'evidence_not_attached'
          )
      )
    ) {
      delete item.verification;
      delete item.planned_verification;
    }
  }
  const seeds = reading.items
    .filter(
      (item) =>
        (item.relevance === 'candidate_event' || item.relevance === 'candidate_plan') &&
        item.temporal === 'historical_body' &&
        item.account.kind !== 'context'
    )
    .map((item) => rationaleAccountText(item.source_account ?? item.account));
  const eligible = items.filter(
    (item) =>
      explanationConnection(item) !== 3 ||
      (item.account &&
        rationaleLexicalSupport(item.account.wording, item.account.reason, seeds) > 0) ||
      item.context.some((entry) =>
        entry.accounts.some(
          (account) =>
            rationaleLexicalSupport(account.statement ?? '', account.reason ?? null, seeds) > 0
        )
      )
  );
  const ordered = orderExplanations(groupExplanations(eligible), file, eligible);
  for (const item of ordered) {
    item.context = item.context.map((entry) => ({
      ...entry,
      reference: entry.reference === item.reference ? null : entry.reference,
      accounts: entry.accounts.map((account) => {
        const { statement, reason, ...state } = account;
        const accounts = [item, ...(item.interpretations ?? [])];
        const wordingFrom = accounts.find(
          (held) =>
            statement &&
            statement.length > held.id.length + 12 &&
            held.account?.wording === statement
        );
        const reasonFrom = accounts.find(
          (held) => reason && reason.length > held.id.length + 12 && held.account?.reason === reason
        );
        return {
          ...state,
          ...(wordingFrom ? { wording_from: wordingFrom.id } : { statement }),
          ...(reasonFrom ? { reason_from: reasonFrom.id } : { reason }),
        };
      }),
    }));
  }
  return {
    answer,
    obligations: answer.entries
      .filter((entry) => entry.placement === 'applicable')
      .map((entry) => focused.get(entry.key)!),
    items: ordered,
    groupedInterpretations: eligible.length - ordered.length,
    excludedLexical: items.length - eligible.length,
    changeSeeds: seeds,
  };
}

export function explanationEvolution(
  reading: Reading,
  items: Explanation[],
  obligations: FocusedKnowledge[],
  previews = true
) {
  const selectedKeys = new Set([
    ...items.flatMap((item) => item.context.map((entry) => entry.id)),
    ...obligations.map((entry) => entry.id),
  ]);
  const endpoint = (ref: Reading['records'][number]['relationships'][number]['from']) => {
    const source = reading.context.entries.find(
      (entry) => entry.target.kind === ref.kind && entry.target.entity_id === ref.entity_id
    );
    const wording = source?.statements.find(
      (statement) => statement.revision.revision_id === ref.revision_id
    );
    return {
      ...ref,
      statement: wording?.text ?? null,
      reason: wording?.rationale ?? null,
      availability: wording ? ('available' as const) : ('not_retrieved' as const),
    };
  };
  const relationships = reading.records
    .filter((record) => selectedKeys.has(record.key))
    .flatMap((record) =>
      record.relationships
        .filter(
          (relationship) =>
            relationship.relation === 'supersedes' || relationship.relation === 'challenges'
        )
        .map((relationship) => ({
          id: relationship.relationship_id,
          kind: 'relationship' as const,
          relationship: relationship.relation,
          standing: relationship.standing,
          applied: relationship.applied,
          not_applied: relationship.not_applied,
          scope: relationship.scope,
          attributed_to: relationship.attributed_to,
          earlier: endpoint(relationship.to),
          later: endpoint(relationship.from),
          because: relationship.because,
        }))
    );
  const passages = items
    .flatMap((item) => [
      item,
      ...(item.interpretations ?? []).map((interpretation) => ({
        ...interpretation,
        source: item.source,
        account: interpretation.account_from ? item.account : interpretation.account,
      })),
    ])
    .filter((item) => item.account && rationaleChangePassage(item.account.wording))
    .map((item) => ({
      id: item.id,
      kind: 'change_passage' as const,
      account_id: item.id,
      source: { artifact_id: item.source.artifact_id, event_id: item.source.event_id },
      authority: item.authority,
      ...(previews
        ? {
            wording: textPreview(item.account!.wording),
            reason: item.account!.reason === null ? null : textPreview(item.account!.reason),
          }
        : {}),
      standing: 'recorded_wording_only' as const,
      qualification:
        'Change-related wording may describe a proposal, rejection, or non-change; read the source account.',
      earlier: null,
      relationship: null,
    }));
  type Passage = (typeof passages)[number];
  const events = new Map<
    string,
    Passage & {
      related_passages: Array<Pick<Passage, 'account_id' | 'authority' | 'wording' | 'reason'>>;
    }
  >();
  for (const passage of passages) {
    const key = passage.source.event_id ? JSON.stringify(passage.source) : passage.id;
    const existing = events.get(key);
    if (existing)
      existing.related_passages.push({
        account_id: passage.account_id,
        authority: passage.authority,
        wording: passage.wording,
        reason: passage.reason,
      });
    else events.set(key, { ...passage, related_passages: [] });
  }
  const outsideScope = reading.context.entries
    .filter((entry) => selectedKeys.has(`${entry.target.kind}:${entry.target.entity_id}`))
    .flatMap((entry) =>
      entry.resolved.omissions
        .filter(
          (omission) => omission.record === 'relationship' && omission.reason === 'another_scope'
        )
        .map((omission) => ({
          id: omission.record_id,
          kind: 'outside_scope' as const,
          applied: false as const,
          not_applied: omission.reason,
          target: entry.target,
        }))
    );
  return [
    ...new Map(
      relationships.map((relationship) => [JSON.stringify(relationship), relationship])
    ).values(),
    ...outsideScope,
    ...events.values(),
  ];
}
