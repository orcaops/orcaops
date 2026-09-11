import { type SearchTokenFields, tokenizeSearchText } from './matching.js';
import type { EventType } from '../../events/event-log.js';
import { redactSecretsInString } from '../../secrets.js';

export const SEARCH_FIELD_MAP_VERSION = 1;
export const SEARCH_SOURCE_KINDS = [
  'plan',
  'checkpoint',
  'summary',
  'evaluator',
  'block-resolution',
  'pin-displaced',
  'lineage',
  'digest',
] as const;
export type SearchSourceKind = (typeof SEARCH_SOURCE_KINDS)[number];
export interface SearchField {
  path: string;
  text: string;
  tokens: string[];
}
export interface SearchFields extends SearchTokenFields {
  intent: SearchField[];
  body: SearchField[];
}

type Path = readonly string[];
const decisions: Path[] = [
  ['decisions', '*', 'decision'],
  ['decisions', '*', 'reason'],
  ['decisions', '*', 'alternatives_considered', '*', 'option'],
  ['decisions', '*', 'alternatives_considered', '*', 'rejected_because'],
  ['decisions', '*', 'evidence', 'quote'],
];
const planBody: Path[] = [
  ['plan_steps', '*', 'label'],
  ['plan_steps', '*', 'text'],
  ['plan_steps', '*', 'acceptance_criteria', '*', 'text'],
  ['non_goals', '*', 'text'],
  ['non_goals', '*', 'rationale'],
  ...decisions,
  ['rationale'],
];
const checkpointBody: Path[] = [
  ['summary'],
  ['reason'],
  ...decisions,
  ['uncertainty', '*'],
  ['done_criteria', '*', 'evidence'],
  ['verification', '*', 'output_digest'],
  ['verification', '*', 'note'],
];
const summaryBody: Path[] = [
  ['outcome'],
  ['tests_written', '*'],
  ['tests_run', '*'],
  ['open_items', '*'],
  ['deferred_decisions', '*'],
  ['accepted_warnings', '*', 'reason'],
];

export const SEARCH_SOURCE_FIELD_MAP: Readonly<
  Record<
    EventType,
    {
      kind: SearchSourceKind | null;
      intent: readonly Path[];
      body: readonly Path[];
    }
  >
> = {
  plan_captured: { kind: 'plan', intent: [['task'], ['label']], body: planBody },
  plan_revised: { kind: 'plan', intent: [['task'], ['label']], body: planBody },
  checkpoint_opened: {
    kind: 'checkpoint',
    intent: [],
    body: [['policy_exceptions', '*', 'reason']],
  },
  checkpoint_closed: { kind: 'checkpoint', intent: [], body: checkpointBody },
  checkpoint_abandoned: { kind: 'checkpoint', intent: [], body: [['reason']] },
  summary_captured: { kind: 'summary', intent: [], body: summaryBody },
  evaluator_run_recorded: { kind: 'evaluator', intent: [], body: [['body'], ['error', 'message']] },
  evaluator_disposition_recorded: { kind: 'block-resolution', intent: [], body: [['reason']] },
  block_acknowledged: { kind: 'block-resolution', intent: [], body: [['reason']] },
  block_dismissed: { kind: 'block-resolution', intent: [], body: [['reason']] },
  pin_displaced: { kind: 'pin-displaced', intent: [], body: [['reason']] },
  branch_lineage_updated: { kind: 'lineage', intent: [], body: [['reason']] },
  git_import_enriched: { kind: null, intent: [], body: [] },
  pre_pr_checked: { kind: null, intent: [], body: [] },
};

function selectFields(value: unknown, path: Path, prefix: string[] = []): SearchField[] {
  if (path.length === 0) {
    if (typeof value !== 'string') return [];
    const text = redactSecretsInString(value);
    return [{ path: prefix.join('.'), text, tokens: tokenizeSearchText(text) }];
  }
  const [key, ...tail] = path;
  if (key === '*')
    return Array.isArray(value)
      ? value.flatMap((item: unknown, index) =>
          selectFields(item, tail, [...prefix, String(index)])
        )
      : [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return selectFields((value as Record<string, unknown>)[key!], tail, [...prefix, key!]);
}

export function searchFieldsForEvent(type: EventType, payload: unknown): SearchFields {
  const map = SEARCH_SOURCE_FIELD_MAP[type];
  const intent = map.intent.flatMap((path) => selectFields(payload, path));
  const body = map.body.flatMap((path) => selectFields(payload, path));
  return {
    intent,
    body,
    intent_fields: intent.map((field) => field.tokens),
    body_fields: body.map((field) => field.tokens),
  };
}

export function derivedDigestFields(
  sources: readonly { sourceId: string; fields: SearchFields }[]
): SearchFields {
  const body = sources.flatMap(({ sourceId, fields }) =>
    [...fields.intent, ...fields.body].map((field) => ({
      ...field,
      path: `${sourceId}.${field.path}`,
      tokens: [...field.tokens],
    }))
  );
  return { intent: [], body, intent_fields: [], body_fields: body.map((field) => field.tokens) };
}
