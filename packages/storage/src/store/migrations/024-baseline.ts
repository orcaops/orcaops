/**
 * The current whole-schema baseline. FTS5 shadow tables are omitted because
 * CREATE VIRTUAL TABLE materializes them. Version numbers are never recycled.
 */
export const BASELINE_VERSION = 24;

export const BASELINE_SCHEMA = `
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO schema_meta (key, value) VALUES ('version', '${BASELINE_VERSION}');
INSERT INTO schema_meta (key, value) VALUES ('projection_health', 'healthy');

CREATE TABLE artifacts (
  id           TEXT PRIMARY KEY,
  branch       TEXT NOT NULL,
  task         TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT 'unlabelled',
  agent        TEXT NOT NULL,
  base_sha     TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  completed_at TEXT,
  status       TEXT NOT NULL CHECK (status IN ('active', 'complete')),
  -- JSON-encoded array.
  non_goals    TEXT NOT NULL DEFAULT '[]',
  cloud_synced_at TEXT,
  cloud_sync_hash TEXT,
  cloud_external_id TEXT,
  cloud_org_id TEXT,
  cloud_last_push_attempt_at TEXT,
  cloud_last_push_error_kind TEXT,
  cloud_last_push_error_message TEXT,
  cloud_consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_artifacts_branch  ON artifacts(branch);
CREATE INDEX idx_artifacts_started ON artifacts(started_at DESC);

CREATE TABLE checkpoints (
  artifact_id        TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  n                  INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('open', 'closed', 'abandoned')),
  declared_step_ids  TEXT NOT NULL DEFAULT '[]',
  agent_session_id   TEXT,
  policy_exceptions  TEXT NOT NULL DEFAULT '[]',
  plan_revision_id   TEXT,
  opened_at          TEXT NOT NULL,
  closed_at          TEXT,
  abandoned_at       TEXT,
  reason             TEXT,
  summary            TEXT,
  files_changed      TEXT NOT NULL DEFAULT '[]',
  decisions          TEXT NOT NULL DEFAULT '[]',
  uncertainty        TEXT NOT NULL DEFAULT '[]',
  done_criteria      TEXT NOT NULL DEFAULT '[]',
  completed_step_ids TEXT NOT NULL DEFAULT '[]',
  head_sha           TEXT NOT NULL,
  open_plan_revision_event_id TEXT,
  CONSTRAINT checkpoints_lifecycle_fields CHECK (
    (status = 'open'
      AND closed_at IS NULL AND abandoned_at IS NULL AND reason IS NULL AND summary IS NULL
      AND files_changed = '[]' AND decisions = '[]' AND uncertainty = '[]'
      AND done_criteria = '[]' AND completed_step_ids = '[]')
    OR
    (status = 'closed'
      AND closed_at IS NOT NULL AND abandoned_at IS NULL AND reason IS NULL AND summary IS NOT NULL)
    OR
    (status = 'abandoned'
      AND closed_at IS NULL AND abandoned_at IS NOT NULL AND reason IS NOT NULL AND summary IS NULL
      AND files_changed = '[]' AND decisions = '[]' AND uncertainty = '[]'
      AND done_criteria = '[]' AND completed_step_ids = '[]')
  ),
  PRIMARY KEY (artifact_id, n)
);
CREATE INDEX idx_checkpoints_files ON checkpoints(files_changed);
CREATE INDEX idx_checkpoints_status ON checkpoints(artifact_id, status);

CREATE TABLE cli_session_branch_state (
  repo_url        TEXT NOT NULL,
  working_dir     TEXT NOT NULL,
  current_branch  TEXT NOT NULL,
  branch_history  TEXT NOT NULL DEFAULT '[]',
  base_commit_sha TEXT,
  last_acked_at   TEXT,
  PRIMARY KEY (repo_url, working_dir)
);

CREATE TABLE plans (
  artifact_id      TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  revision_n       INTEGER NOT NULL,
  captured_at      TEXT NOT NULL,
  rationale        TEXT,
  touched_scope    TEXT NOT NULL DEFAULT '[]',
  non_goals        TEXT NOT NULL DEFAULT '[]',
  step_lineage     TEXT NOT NULL DEFAULT '{}',
  prior_event_id   TEXT,
  source_event_id  TEXT NOT NULL,
  label            TEXT NOT NULL DEFAULT 'unlabelled',
  criterion_lineage TEXT NOT NULL DEFAULT '{"added":[],"removed":[],"rewritten":[]}',
  decisions        TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (artifact_id, revision_n)
);
CREATE INDEX idx_plans_artifact ON plans(artifact_id);

CREATE TABLE plan_steps (
  artifact_id         TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  revision_n          INTEGER NOT NULL,
  step_id             TEXT NOT NULL,
  idx                 INTEGER NOT NULL,
  text                TEXT NOT NULL,
  label               TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (artifact_id, revision_n, step_id),
  FOREIGN KEY (artifact_id, revision_n) REFERENCES plans(artifact_id, revision_n) ON DELETE CASCADE
);
CREATE INDEX idx_plan_steps_idx ON plan_steps(artifact_id, revision_n, idx);

CREATE TABLE plan_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  artifact_id     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_plan_idempotency_artifact ON plan_idempotency(artifact_id);

CREATE TABLE idempotency_blocks (
  artifact_id           TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  idempotency_key       TEXT NOT NULL,
  event_type            TEXT NOT NULL,
  outcome               TEXT NOT NULL CHECK (outcome IN ('soft_blocked', 'hard_rejected')),
  payload_hash          TEXT NOT NULL,
  evaluator_fingerprint TEXT,
  envelope              TEXT,
  recorded_at           TEXT NOT NULL,
  PRIMARY KEY (artifact_id, idempotency_key, event_type)
);
CREATE INDEX idx_idempotency_blocks_artifact ON idempotency_blocks(artifact_id);

CREATE TABLE summaries (
  artifact_id   TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  outcome       TEXT NOT NULL,
  tests_written TEXT NOT NULL DEFAULT '[]',
  tests_run     TEXT NOT NULL DEFAULT '[]',
  open_items    TEXT NOT NULL DEFAULT '[]',
  ts            TEXT NOT NULL
);

CREATE TABLE evaluator_lifecycles (
  artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  fires_at      TEXT NOT NULL CHECK (fires_at IN ('post-plan', 'post-plan-revision', 'checkpoint-open', 'checkpoint-close', 'pre-pr')),
  cp_n          INTEGER NOT NULL DEFAULT 0,
  triggered_at  TEXT NOT NULL,
  PRIMARY KEY (artifact_id, fires_at, cp_n)
);
CREATE INDEX idx_eval_lifecycles_artifact ON evaluator_lifecycles(artifact_id);

CREATE TABLE evaluator_runs (
  run_id              TEXT PRIMARY KEY,
  artifact_id         TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  evaluator_ref       TEXT NOT NULL,
  package_id          TEXT NOT NULL,
  evaluator_id        TEXT NOT NULL,
  phase               TEXT NOT NULL,
  severity            TEXT NOT NULL,
  run_status          TEXT NOT NULL CHECK (run_status IN ('completed', 'error', 'skipped')),
  verdict             TEXT CHECK (verdict IS NULL OR verdict IN ('pass', 'violation', 'info')),
  body                TEXT NOT NULL,
  raw                 TEXT, -- JSON-stringified payload, optional
  metrics             TEXT, -- JSON-stringified Record<string, number>, optional
  -- LLM-only fields. Cache_read / cache_write track Anthropic
  -- prompt-cache usage; command-engine runs leave them NULL.
  provider            TEXT CHECK (provider IS NULL OR provider IN ('claude', 'codex')),
  model               TEXT,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  tokens_cache_read   INTEGER,
  tokens_cache_write  INTEGER,
  cost_usd            REAL,
  -- Engine-side execution metrics.
  duration_ms         INTEGER,
  checkpoint_n        INTEGER,
  -- Structured error payload when run_status='error'.
  error_code          TEXT,
  error_message       TEXT,
  ts                  TEXT NOT NULL,
  -- Materialized disposition. NULL for runs that
  -- are not blocking-eligible (pass / info / error / skipped, or
  -- non-block severity); one of 'unresolved' | 'acknowledged' |
  -- 'dismissed' | 'policy-excepted' otherwise.
  disposition         TEXT CHECK (
    disposition IS NULL OR
    disposition IN ('unresolved', 'acknowledged', 'dismissed', 'policy-excepted')
  ),
  -- Order-key components. Strict total order
  -- across runs + dispositions used by every projection walk
  -- (block-state, digest collapse, cloud wire). \`ts\` is preserved
  -- separately for display only and is NOT authoritative for
  -- ordering.
  source_event_index  INTEGER NOT NULL,
  local_kind_rank     INTEGER NOT NULL CHECK (local_kind_rank = 0), -- always 0 for runs
  local_index         INTEGER NOT NULL
);
CREATE INDEX evaluator_runs_artifact_order ON evaluator_runs(
  artifact_id, source_event_index, local_kind_rank, local_index
);
CREATE INDEX evaluator_runs_artifact_ref ON evaluator_runs(artifact_id, evaluator_ref);
CREATE INDEX evaluator_runs_artifact_ts ON evaluator_runs(artifact_id, ts);

CREATE TABLE evaluator_dispositions (
  disposition_id      TEXT PRIMARY KEY,
  artifact_id         TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  run_id              TEXT NOT NULL REFERENCES evaluator_runs(run_id),
  evaluator_ref       TEXT NOT NULL,
  disposition         TEXT NOT NULL CHECK (
    disposition IN ('acknowledged', 'dismissed', 'policy-excepted')
  ),
  reason              TEXT NOT NULL,
  agent_session_id    TEXT,
  ts                  TEXT NOT NULL,
  source_event_index  INTEGER NOT NULL,
  local_kind_rank     INTEGER NOT NULL CHECK (local_kind_rank = 1), -- always 1 for dispositions
  local_index         INTEGER NOT NULL
);
CREATE INDEX evaluator_dispositions_artifact_order ON evaluator_dispositions(
  artifact_id, source_event_index, local_kind_rank, local_index
);
CREATE INDEX evaluator_dispositions_artifact_ts ON evaluator_dispositions(artifact_id, ts);
CREATE INDEX evaluator_dispositions_run ON evaluator_dispositions(run_id);

CREATE TABLE lineage_by_latest_sha (
  artifact_id        TEXT PRIMARY KEY,
  latest_lineage_sha TEXT NOT NULL,
  branch_name        TEXT NOT NULL
);
CREATE INDEX idx_lineage_by_latest_sha_sha ON lineage_by_latest_sha(latest_lineage_sha);

CREATE TABLE lineage_branches (
  artifact_id TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  PRIMARY KEY (artifact_id, branch_name)
);
CREATE INDEX idx_lineage_branches_branch ON lineage_branches(branch_name);

CREATE TABLE source_plan_links (
  source_plan_ref_id TEXT NOT NULL,
  artifact_id        TEXT NOT NULL,
  linked_at          TEXT NOT NULL,
  pinned_version     TEXT,
  PRIMARY KEY (source_plan_ref_id, artifact_id)
);
CREATE INDEX idx_source_plan_links_artifact ON source_plan_links(artifact_id);

CREATE TABLE usage_snapshots (
  snapshot_id                            TEXT PRIMARY KEY,
  idempotency_key                        TEXT NOT NULL UNIQUE,
  artifact_id                            TEXT,
  source_plan_ref_id                     TEXT,
  agent                                  TEXT NOT NULL,
  session_id                             TEXT NOT NULL,
  lifecycle_event                        TEXT NOT NULL,
  checkpoint_n                           INTEGER,
  cumulative_input_tokens                INTEGER NOT NULL,
  cumulative_output_tokens               INTEGER NOT NULL,
  cumulative_cache_creation_input_tokens INTEGER NOT NULL,
  cumulative_cache_read_input_tokens     INTEGER NOT NULL,
  delta_input_tokens                     INTEGER,
  delta_output_tokens                    INTEGER,
  delta_cache_creation_input_tokens      INTEGER,
  delta_cache_read_input_tokens          INTEGER,
  baseline_kind                          TEXT NOT NULL CHECK (baseline_kind IN (
    'first_observation', 'prior_same_artifact', 'prior_same_source_plan',
    'checkpoint_open', 'whole_session'
  )),
  model_breakdown                        TEXT NOT NULL DEFAULT '[]',
  record_count                           INTEGER NOT NULL,
  as_of                                  TEXT NOT NULL,
  ts                                     TEXT NOT NULL,
  dimensions                             TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_usage_snapshots_artifact ON usage_snapshots(artifact_id, ts);
CREATE INDEX idx_usage_snapshots_session ON usage_snapshots(agent, session_id);
CREATE INDEX idx_usage_snapshots_source_plan ON usage_snapshots(source_plan_ref_id);

CREATE VIRTUAL TABLE search_idx USING fts5(
  artifact_id UNINDEXED,
  source,
  branch UNINDEXED,
  ts UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);

CREATE VIEW coding_sessions AS
  SELECT
    agent,
    session_id,
    MAX(cumulative_input_tokens)                AS cumulative_input_tokens,
    MAX(cumulative_output_tokens)               AS cumulative_output_tokens,
    MAX(cumulative_cache_creation_input_tokens) AS cumulative_cache_creation_input_tokens,
    MAX(cumulative_cache_read_input_tokens)     AS cumulative_cache_read_input_tokens,
    MAX(as_of)                                  AS as_of,
    MAX(record_count)                           AS record_count
  FROM usage_snapshots
  GROUP BY agent, session_id;
`;
