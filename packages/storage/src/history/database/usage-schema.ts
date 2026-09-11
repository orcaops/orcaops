export const PROJECT_USAGE_SCHEMA = `
CREATE TABLE usage_events (
  event_id TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  record_bytes BLOB NOT NULL,
  sidecar_payload_bytes BLOB,
  checksum TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  event_identity TEXT NOT NULL,
  snapshot_identity TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('agent_usage_snapshot_recorded', 'source_plan_linked')),
  recorded_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  completeness_json TEXT NOT NULL CHECK (json_valid(completeness_json))
) STRICT;
CREATE INDEX usage_event_type_lookup ON usage_events(event_type, event_id);
CREATE TABLE usage_revisions (
  generation INTEGER PRIMARY KEY CHECK (generation BETWEEN 1 AND 9007199254740991),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  ordered_hash TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count BETWEEN 1 AND 9007199254740991),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 9007199254740991),
  tail_event_id TEXT NOT NULL REFERENCES usage_events(event_id)
) STRICT;
CREATE TABLE usage_selection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  current_generation INTEGER NOT NULL REFERENCES usage_revisions(generation) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE usage_snapshots (
  event_id TEXT PRIMARY KEY REFERENCES usage_events(event_id),
  snapshot_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  artifact_id TEXT,
  source_plan_ref_id TEXT,
  lifecycle_event TEXT NOT NULL,
  checkpoint_n INTEGER,
  baseline_kind TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  as_of TEXT NOT NULL,
  cumulative_json TEXT NOT NULL CHECK (json_valid(cumulative_json)),
  delta_json TEXT NOT NULL CHECK (json_valid(delta_json)),
  model_breakdown_json TEXT NOT NULL CHECK (json_valid(model_breakdown_json))
) STRICT;
CREATE INDEX usage_session_lookup ON usage_snapshots(agent, session_id, as_of, snapshot_id);
CREATE INDEX usage_artifact_lookup ON usage_snapshots(artifact_id, agent, session_id);
CREATE INDEX usage_source_plan_lookup ON usage_snapshots(source_plan_ref_id, agent, session_id);
CREATE INDEX usage_snapshot_lookup ON usage_snapshots(snapshot_id);
CREATE TABLE usage_links (
  event_id TEXT PRIMARY KEY REFERENCES usage_events(event_id),
  canonical_ref_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  pinned_version TEXT
) STRICT;
CREATE INDEX usage_link_artifact_lookup ON usage_links(artifact_id, canonical_ref_id, linked_at);
CREATE TRIGGER usage_selection_no_delete BEFORE DELETE ON usage_selection BEGIN
  SELECT RAISE(ABORT, 'Usage publication selection is retained');
END;
CREATE TRIGGER usage_events_no_update BEFORE UPDATE ON usage_events BEGIN
  SELECT RAISE(ABORT, 'Original usage events are immutable');
END;
CREATE TRIGGER usage_events_no_delete BEFORE DELETE ON usage_events BEGIN
  SELECT RAISE(ABORT, 'Original usage events are retained');
END;
CREATE TRIGGER usage_revisions_no_update BEFORE UPDATE ON usage_revisions BEGIN
  SELECT RAISE(ABORT, 'Usage publication revisions are immutable');
END;
CREATE TRIGGER usage_revisions_no_delete BEFORE DELETE ON usage_revisions BEGIN
  SELECT RAISE(ABORT, 'Usage publication revisions are retained');
END;
`;
