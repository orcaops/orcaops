import type { ProjectReadView } from './connection.js';
import {
  RATIONALE_ACCOUNT_BYTES,
  RATIONALE_ACCOUNT_TERMS,
  RATIONALE_EVENT_ACCOUNTS,
  RATIONALE_INDEX_VERSION,
  rationaleAccounts,
  rationaleAccountText,
  rationaleTerms,
} from './rationale-accounts.js';
import { rationaleChangePassage, rationaleLexicalSupport } from './rationale-relevance.js';
import type { ProjectSettlement } from './transactions.js';
import type { ArtifactThread } from '../../events/artifact-thread.js';

export function prepareRationaleIndex(thread: ArtifactThread) {
  return thread.events.flatMap((event, index) => {
    if (
      !['plan_captured', 'plan_revised', 'checkpoint_closed', 'summary_captured'].includes(
        event.record.type
      )
    )
      return [];
    const accounts = rationaleAccounts(event.record.type, event.payload);
    let omittedTerms = 0;
    const retained = accounts.slice(0, RATIONALE_EVENT_ACCOUNTS).flatMap((account) => {
      const json = JSON.stringify(account);
      if (Buffer.byteLength(json) > RATIONALE_ACCOUNT_BYTES) return [];
      const terms = rationaleTerms(rationaleAccountText(account));
      omittedTerms += Math.max(0, terms.length - RATIONALE_ACCOUNT_TERMS);
      return [{ path: account.path, json, terms: terms.slice(0, RATIONALE_ACCOUNT_TERMS) }];
    });
    return [
      {
        eventId: event.record.event_id,
        ordinal: index + 1,
        accounts: retained,
        omittedAccounts: accounts.length - retained.length,
        omittedTerms,
      },
    ];
  });
}

export function replaceRationaleIndex(
  transaction: Pick<ProjectSettlement, 'run'>,
  artifactId: string,
  rows: ReturnType<typeof prepareRationaleIndex>
): void {
  transaction.run('DELETE FROM rationale_events WHERE artifact_id=?', artifactId);
  for (const row of rows) {
    transaction.run(
      'INSERT INTO rationale_events VALUES (?,?,?,?,?)',
      row.eventId,
      artifactId,
      row.ordinal,
      row.omittedAccounts,
      row.omittedTerms
    );
    for (const account of row.accounts) {
      transaction.run(
        'INSERT INTO rationale_accounts VALUES (?,?,?)',
        row.eventId,
        account.path,
        account.json
      );
      for (const term of account.terms)
        transaction.run(
          'INSERT INTO rationale_terms VALUES (?,?,?)',
          term,
          row.eventId,
          account.path
        );
    }
  }
  transaction.run('DELETE FROM rationale_pending_artifacts WHERE artifact_id=?', artifactId);
}

export function rationaleIndexStatus(view: ProjectReadView): 'available' | 'unavailable' | 'stale' {
  const state = view.get<{ version: number }>(
    'SELECT version FROM rationale_index_state WHERE singleton=1'
  );
  if (!state) return 'unavailable';
  if (
    state.version !== RATIONALE_INDEX_VERSION ||
    view.get('SELECT artifact_id FROM rationale_pending_artifacts LIMIT 1')
  )
    return 'stale';
  return 'available';
}

export const RATIONALE_DISCOVERY_BOUNDS = {
  terms: 32,
  postingsPerTerm: 256,
  postings: 4096,
  accounts: 32,
  changeAccounts: 8,
} as const;

export function discoverRationaleAccounts(
  view: ProjectReadView,
  seedAccounts: readonly string[],
  excludedEvents: readonly string[]
) {
  const status = rationaleIndexStatus(view);
  const seeds = seedAccounts.map((text) =>
    rationaleTerms(text)
      .filter((term) => !/^\d+$/.test(term))
      .slice(0, 16)
  );
  const terms: string[] = [];
  for (let position = 0; position < 16; position++)
    for (const seed of seeds) {
      const term = seed[position];
      if (term && !terms.includes(term)) terms.push(term);
    }
  const matches = new Map<string, { eventId: string; path: string; terms: string[] }>();
  let visited = 0;
  let saturated = 0;
  if (status === 'available')
    for (const term of terms.slice(0, RATIONALE_DISCOVERY_BOUNDS.terms)) {
      const allowance = Math.min(
        RATIONALE_DISCOVERY_BOUNDS.postingsPerTerm,
        RATIONALE_DISCOVERY_BOUNDS.postings - visited
      );
      if (allowance <= 0) {
        saturated++;
        continue;
      }
      const rows = view.all<{ event_id: string; field_path: string }>(
        'SELECT event_id, field_path FROM rationale_terms WHERE term=? ORDER BY event_id, field_path LIMIT ?',
        term,
        allowance
      );
      if (rows.length === allowance) saturated++;
      for (const row of rows.slice(0, allowance)) {
        visited++;
        if (excludedEvents.includes(row.event_id)) continue;
        const key = `${row.event_id}:${row.field_path}`;
        const entry = matches.get(key) ?? {
          eventId: row.event_id,
          path: row.field_path,
          terms: [],
        };
        entry.terms.push(term);
        matches.set(key, entry);
      }
    }
  const overlapping = [...matches.values()].filter((entry) =>
    seeds.some(
      (seed) =>
        seed.filter((term) => entry.terms.includes(term)).length >=
        Math.min(3, Math.max(2, seed.length))
    )
  );
  const previews = new Map(
    view
      .all<{
        event_id: string;
        field_path: string;
        wording: string;
        reason: string | null;
        truncated: number;
      }>(
        `SELECT a.event_id, a.field_path,
      substr(json_extract(a.account_json,'$.wording'),1,1024) AS wording,
      substr(json_extract(a.account_json,'$.reason'),1,512) AS reason,
      (length(json_extract(a.account_json,'$.wording'))>1024 OR coalesce(length(json_extract(a.account_json,'$.reason')),0)>512) AS truncated
     FROM json_each(?) hit JOIN rationale_accounts a
       ON a.event_id=json_extract(hit.value,'$.eventId') AND a.field_path=json_extract(hit.value,'$.path')`,
        JSON.stringify(overlapping)
      )
      .map((row) => [`${row.event_id}:${row.field_path}`, row])
  );
  const qualified = overlapping.flatMap((entry) => {
    const preview = previews.get(`${entry.eventId}:${entry.path}`);
    const support = preview
      ? rationaleLexicalSupport(preview.wording, preview.reason, seedAccounts)
      : 0;
    return support ? [{ ...entry, support, change: rationaleChangePassage(preview!.wording) }] : [];
  });
  qualified.sort(
    (a, b) =>
      b.support - a.support || a.eventId.localeCompare(b.eventId) || a.path.localeCompare(b.path)
  );
  const changes = qualified
    .filter((entry) => entry.change)
    .slice(0, RATIONALE_DISCOVERY_BOUNDS.changeAccounts);
  const selected = [...changes, ...qualified.filter((entry) => !changes.includes(entry))].slice(
    0,
    RATIONALE_DISCOVERY_BOUNDS.accounts
  );
  return {
    matches: selected.map(({ eventId, path, terms }) => ({ eventId, path, terms })),
    diagnostics: {
      status,
      terms: Math.min(terms.length, RATIONALE_DISCOVERY_BOUNDS.terms),
      omitted_terms: Math.max(0, terms.length - RATIONALE_DISCOVERY_BOUNDS.terms),
      postings_examined: visited,
      saturated_terms: saturated,
      matched_accounts: qualified.length,
      rejected_accounts: overlapping.length - qualified.length,
      qualification_previews: previews.size,
      truncated_qualification_previews: [...previews.values()].filter(
        (preview) => preview.truncated
      ).length,
      omitted_accounts: Math.max(0, qualified.length - RATIONALE_DISCOVERY_BOUNDS.accounts),
      index_limits: {
        accounts_per_event: RATIONALE_EVENT_ACCOUNTS,
        bytes_per_account: RATIONALE_ACCOUNT_BYTES,
        terms_per_account: RATIONALE_ACCOUNT_TERMS,
      },
    },
  };
}
