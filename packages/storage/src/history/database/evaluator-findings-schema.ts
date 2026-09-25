// What an evaluator run established beside itself: the findings its producer stated, a record
// that findings were offered and could not be read, and the basis the run was given. These are
// supplemental records keyed to the run, written in the settlement that retains the run event, so
// a replayed settlement replays both or neither. Nothing here touches
// `orcaops.evaluator_run/v1`, the gate audit embedded in `checkpoint_opened`, or the cloud wire
// shape: that payload is strict, is re-parsed on every thread rebuild, and old retained history
// would fail its own rebuild if a field were added to it.
//
// Like the knowledge family, a retained row keeps the handed-over record once as record_bytes and
// every other column is a lookup copy the writer keeps equal to it in the publishing transaction.
import { insertOnlyGuards, sha256 } from './exact-revision-schema.js';

const CONCLUSIONS = "'supported','contradicted','unresolved'";
const FINDINGS_SOURCES = "'markdown-block','envelope'";

const authored = `record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  record_sha256 TEXT NOT NULL CHECK (${sha256('record_sha256')}),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED`;
const named = (column: string) => `${column} TEXT NOT NULL CHECK (length(${column})>0)`;
const optional = (column: string) =>
  `${column} TEXT CHECK (${column} IS NULL OR length(${column})>0)`;

// The artifact and the evaluator are the run event's, read from the settlement that established
// it, never from the handed-over record: the run event owns them and a second authored copy is a
// second place for them to disagree.
const ofRun = `artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  ${named('evaluator_ref')}`;

const tables = `
CREATE TABLE evaluator_run_contexts (
  run_id TEXT PRIMARY KEY CHECK (length(run_id)>0),
  ${ofRun},
  ${optional('evaluator_version')},
  context_sha256 TEXT CHECK (context_sha256 IS NULL OR (${sha256('context_sha256')})),
  ${optional('base_sha')},
  ${optional('head_sha')},
  producer_payload_bytes BLOB,
  producer_payload_sha256 TEXT CHECK (
    (producer_payload_bytes IS NULL) = (producer_payload_sha256 IS NULL)
    AND (producer_payload_sha256 IS NULL OR (${sha256('producer_payload_sha256')}))
  ),
  ${authored}
) STRICT;
CREATE INDEX evaluator_run_context_evaluator ON evaluator_run_contexts(artifact_id, evaluator_ref);
CREATE TABLE evaluator_run_findings (
  run_id TEXT PRIMARY KEY CHECK (length(run_id)>0),
  ${ofRun},
  finding_count INTEGER NOT NULL CHECK (finding_count BETWEEN 1 AND 9007199254740991),
  notice_json TEXT CHECK (notice_json IS NULL OR json_valid(notice_json)),
  ${authored}
) STRICT;
CREATE TABLE evaluator_findings (
  run_id TEXT NOT NULL REFERENCES evaluator_run_findings(run_id),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
  ${ofRun},
  ${optional('finding_key')},
  ${named('title')},
  ${optional('detail')},
  locations_json TEXT CHECK (locations_json IS NULL OR json_valid(locations_json)),
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN (${CONCLUSIONS})),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (run_id, position)
) STRICT;
-- "Has this evaluator said this about this artifact before" is answered from this index alone,
-- and never across artifacts: a finding cannot be reached from any artifact but the one it
-- originates in. A finding whose producer set no key has no cross-run identity and is left out
-- of the index rather than given a derived one. Keys are unique within one run, so the tuple is.
CREATE UNIQUE INDEX evaluator_finding_recurrence ON evaluator_findings(artifact_id, evaluator_ref, finding_key, run_id) WHERE finding_key IS NOT NULL;
-- Not a finding and not a verdict: the run keeps the verdict and the gate it would have had, and
-- this says that something was offered and could not be established. At most one per run.
CREATE TABLE evaluator_findings_unreadable (
  run_id TEXT PRIMARY KEY CHECK (length(run_id)>0),
  ${ofRun},
  source TEXT NOT NULL CHECK (source IN (${FINDINGS_SOURCES})),
  ${named('detail')},
  ${authored}
) STRICT;
-- A capture whose events also publish a retained Git ref is admitted first and settled later from
-- what the admission retained, never from the caller's second call, so the handover is retained
-- with the request: a resumed settlement then writes exactly what the interrupted one would have,
-- and the operation payload that identifies the capture stays the same across both.
-- The producer payload is bytes rather than JSON, so it is kept beside the record instead of in it.
CREATE TABLE pending_capture_evaluator_evidence (
  original_operation_id TEXT NOT NULL REFERENCES pending_capture_requests(original_operation_id),
  ${named('run_id')},
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991),
  evidence_bytes BLOB NOT NULL CHECK (json_valid(CAST(evidence_bytes AS TEXT))),
  producer_payload_bytes BLOB,
  PRIMARY KEY (original_operation_id, position),
  UNIQUE (original_operation_id, run_id)
) STRICT;
`;

// The runner hands over exactly one outcome per run, so "none supplied" and "supplied but
// unreadable" can never both be retained for one run.
const oneOutcome = [
  ['evaluator_run_findings', 'evaluator_findings_unreadable'],
  ['evaluator_findings_unreadable', 'evaluator_run_findings'],
]
  .map(
    ([table, other]) => `
CREATE TRIGGER ${table}_one_outcome BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM ${other} WHERE run_id=NEW.run_id) BEGIN
  SELECT RAISE(ABORT, 'A run hands over what became of its findings once');
END;`
  )
  .join('');

// The context is what makes an observation built from this run able to name its basis, and it is
// also what tells a run this build retained nothing for from one retained before these tables
// existed. Requiring it keeps that difference readable instead of leaving it to a convention.
const requiresContext = ['evaluator_run_findings', 'evaluator_findings_unreadable']
  .map(
    (table) => `
CREATE TRIGGER ${table}_requires_context BEFORE INSERT ON ${table}
WHEN NOT EXISTS (SELECT 1 FROM evaluator_run_contexts WHERE run_id=NEW.run_id) BEGIN
  SELECT RAISE(ABORT, 'Retained findings require the context the run was given');
END;`
  )
  .join('');

// The lookup copies a recurrence is asked by are the establishing run's own, so a finding cannot
// be filed under an artifact or an evaluator its run does not belong to.
const findingBelongsToItsRun = `
CREATE TRIGGER evaluator_finding_matches_run BEFORE INSERT ON evaluator_findings
WHEN NOT EXISTS (
  SELECT 1 FROM evaluator_run_findings
  WHERE run_id=NEW.run_id AND artifact_id=NEW.artifact_id AND evaluator_ref=NEW.evaluator_ref
) BEGIN
  SELECT RAISE(ABORT, 'A finding belongs to the artifact and evaluator of the run that established it');
END;`;

const retained = [
  ['evaluator_run_contexts', 'run_id=NEW.run_id'],
  ['evaluator_run_findings', 'run_id=NEW.run_id'],
  ['evaluator_findings', 'run_id=NEW.run_id AND position=NEW.position'],
  ['evaluator_findings_unreadable', 'run_id=NEW.run_id'],
  [
    'pending_capture_evaluator_evidence',
    'original_operation_id=NEW.original_operation_id AND (position=NEW.position OR run_id=NEW.run_id)',
  ],
] as const;

export const PROJECT_EVALUATOR_FINDINGS_SCHEMA =
  tables +
  oneOutcome +
  requiresContext +
  findingBelongsToItsRun +
  insertOnlyGuards(retained, 'Retained evaluator findings');
