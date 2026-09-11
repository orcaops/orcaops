export const PROJECT_SEARCH_SCHEMA = `
CREATE TABLE artifact_search_state (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id),
  generation INTEGER NOT NULL,
  source_count INTEGER NOT NULL CHECK (source_count >= 0),
  normalization_version INTEGER NOT NULL,
  field_map_version INTEGER NOT NULL,
  FOREIGN KEY (artifact_id, generation) REFERENCES artifact_revisions(artifact_id, generation)
) STRICT;
CREATE TABLE artifact_search_sources (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  origin_rank INTEGER NOT NULL CHECK (origin_rank IN (0, 1)),
  evidence_time TEXT,
  tokens_json TEXT NOT NULL CHECK (json_valid(tokens_json)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (artifact_id, source_id)
) STRICT;
CREATE INDEX artifact_search_kind ON artifact_search_sources(source_kind, artifact_id);
CREATE TABLE artifact_touched_files (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  file_path TEXT NOT NULL,
  PRIMARY KEY (artifact_id, file_path)
) STRICT;
`;
