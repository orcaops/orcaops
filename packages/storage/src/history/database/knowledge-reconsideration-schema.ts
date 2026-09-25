// Reconsideration items and their dispositions: the work a change reaches, retained once per
// affected item and cause, and, in a table of its own, what somebody decided to do about it.
//
// Two rules live in the tables rather than in a writer. One signal for one affected item and cause
// is one item, which the identity tuple holds by being unique; and a closed item takes no further
// disposition, which a trigger holds because it is a rule about rows a writer could forget. Nothing
// here can edit an item: a disposition is a row beside it, never a column on it, so the facts the
// item was opened on stay exactly as they were retained.
//
// Like the rest of the knowledge family a row keeps the authored record once as record_bytes and
// every other column is a lookup copy the writer keeps equal to it in the publishing transaction.
import { ATTRIBUTION_BASES, insertOnlyGuards, sha256 } from './exact-revision-schema.js';

/** What a traversal can reach, which is what an item can be about. */
const AFFECTED_KINDS =
  "'requirement','decision','claim','plan_event','artifact','assessment','code_path'";
/** The three changes a consequence traversal starts from. */
const CAUSE_KINDS = "'revision','assumption','implementation'";
const DISPOSITIONS = "'acknowledged','reconsidered','declined','superseded'";
/** A disposition after which the item is closed, so nothing further is appended to it. */
const CLOSING = "'reconsidered','declined','superseded'";
const OUTCOMES = "'revision','assessment','unchanged'";

const authored = `record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  record_sha256 TEXT NOT NULL CHECK (${sha256('record_sha256')}),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED`;

// An owner nobody is named for has no name, no basis worth the word and no record to point at.
const owner = `owner TEXT CHECK (owner IS NULL OR length(owner)>0),
  owner_basis TEXT NOT NULL CHECK (owner_basis IN (${ATTRIBUTION_BASES}) AND (owner IS NULL)=(owner_basis='unknown')),
  owner_from TEXT CHECK ((owner_from IS NOT NULL)=(owner IS NOT NULL) AND (owner_from IS NULL OR length(owner_from)>0))`;

const tables = `
CREATE TABLE reconsideration_items (
  item_id TEXT PRIMARY KEY CHECK (${sha256('item_id')}),
  affected_kind TEXT NOT NULL CHECK (affected_kind IN (${AFFECTED_KINDS})),
  affected_id TEXT NOT NULL CHECK (length(affected_id)>0),
  cause_kind TEXT NOT NULL CHECK (cause_kind IN (${CAUSE_KINDS})),
  cause_id TEXT NOT NULL CHECK (${sha256('cause_id')}),
  opened_at_boundary INTEGER NOT NULL CHECK (opened_at_boundary BETWEEN 0 AND 9007199254740991),
  ${owner},
  ${authored},
  UNIQUE (affected_kind, affected_id, cause_kind, cause_id)
) STRICT;
-- Open items oldest first, which is the order every listing reads them in.
CREATE INDEX reconsideration_item_opened ON reconsideration_items(opened_at_boundary, item_id);
CREATE TABLE reconsideration_dispositions (
  item_id TEXT NOT NULL REFERENCES reconsideration_items(item_id) DEFERRABLE INITIALLY DEFERRED,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
  disposition TEXT NOT NULL CHECK (disposition IN (${DISPOSITIONS})),
  outcome_kind TEXT CHECK (
    (outcome_kind IS NOT NULL)=(disposition='reconsidered')
    AND (outcome_kind IS NULL OR outcome_kind IN (${OUTCOMES}))
  ),
  outcome_id TEXT CHECK (
    (outcome_id IS NOT NULL)=coalesce(outcome_kind IN ('revision','assessment'), 0)
    AND (outcome_id IS NULL OR length(outcome_id)>0)
  ),
  reason TEXT CHECK ((reason IS NOT NULL)=(disposition='declined') AND (reason IS NULL OR length(reason)>0)),
  superseded_by_item_id TEXT REFERENCES reconsideration_items(item_id) DEFERRABLE INITIALLY DEFERRED CHECK (
    (superseded_by_item_id IS NOT NULL)=(disposition='superseded')
    AND (superseded_by_item_id IS NULL OR superseded_by_item_id<>item_id)
  ),
  disposed_by TEXT CHECK (disposed_by IS NULL OR length(disposed_by)>0),
  disposed_by_basis TEXT NOT NULL CHECK (disposed_by_basis IN (${ATTRIBUTION_BASES}) AND (disposed_by IS NULL)=(disposed_by_basis='unknown')),
  disposed_at TEXT NOT NULL CHECK (length(disposed_at)>0),
  ${authored},
  PRIMARY KEY (item_id, position)
) STRICT;
`;

// The rule with teeth on the disposition side. An item that was reconsidered, declined or
// superseded has been decided; a later row would be a second decision about one item with nothing
// in either row saying which one holds. Acknowledgement is not a decision, so it does not close.
const closedTakesNoMore = `
CREATE TRIGGER reconsideration_disposition_requires_open BEFORE INSERT ON reconsideration_dispositions
WHEN EXISTS (
  SELECT 1 FROM reconsideration_dispositions
   WHERE item_id=NEW.item_id AND disposition IN (${CLOSING})
) BEGIN
  SELECT RAISE(ABORT, 'A reconsideration item that has been disposed of takes no further disposition');
END;`;

const retained = [
  ['reconsideration_items', 'item_id=NEW.item_id'],
  ['reconsideration_dispositions', 'item_id=NEW.item_id AND position=NEW.position'],
] as const;

export const PROJECT_KNOWLEDGE_RECONSIDERATION_SCHEMA =
  tables + closedTakesNoMore + insertOnlyGuards(retained, 'Reconsideration records');
