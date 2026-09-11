const retainedKeys = {
  review_semantic_generations: 'generation_id = NEW.generation_id',
  review_semantic_attempts:
    'revision_id = NEW.revision_id OR (generation_id = NEW.generation_id AND attempt_number = NEW.attempt_number)',
  review_semantic_terminals:
    'generation_id = NEW.generation_id OR terminal_attempt_revision_id = NEW.terminal_attempt_revision_id OR (NEW.model_publication_id IS NOT NULL AND model_publication_id = NEW.model_publication_id)',
} as const;

export const PROJECT_REVIEW_SEMANTIC_SCHEMA = `
CREATE UNIQUE INDEX review_finalization_semantic_owner ON review_run_finalizations(review_id, run_id, run_revision_id);
CREATE UNIQUE INDEX review_input_semantic_owner ON review_evidence_publications(review_id, run_id, run_revision_id, publication_id, kind);
CREATE TABLE review_semantic_generations (
  generation_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  terminal_revision_id TEXT NOT NULL,
  input_publication_id TEXT NOT NULL,
  input_kind TEXT NOT NULL DEFAULT 'semantic' CHECK (input_kind = 'semantic'),
  created_operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (review_id, run_id) REFERENCES review_runs(review_id, run_id),
  FOREIGN KEY (review_id, run_id, terminal_revision_id) REFERENCES review_run_finalizations(review_id, run_id, run_revision_id),
  FOREIGN KEY (review_id, run_id, terminal_revision_id, input_publication_id, input_kind) REFERENCES review_evidence_publications(review_id, run_id, run_revision_id, publication_id, kind),
  UNIQUE (review_id, run_id, generation_id)
) STRICT;
CREATE TABLE review_semantic_attempts (
  revision_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES review_semantic_generations(generation_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number IN (1, 2)),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  record_sha256 TEXT NOT NULL CHECK (length(record_sha256) = 64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  accepted INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.accepted')) STORED NOT NULL CHECK (accepted IN (0, 1)),
  outcome TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.outcome')) STORED NOT NULL,
  CHECK ((json_extract(record_json, '$.schema_version') = 3) IS TRUE),
  CHECK ((json_extract(record_json, '$.generation_id') = generation_id) IS TRUE),
  CHECK ((json_extract(record_json, '$.attempt') = attempt_number) IS TRUE),
  CHECK ((attempt_number = 1 AND ((accepted = 1 AND outcome IN ('ACCEPTED_CLEAN_FIRST_PASS', 'ACCEPTED_NORMALIZED_FIRST_PASS')) OR (accepted = 0 AND outcome = 'REJECTED_FIRST_PASS'))) OR
         (attempt_number = 2 AND ((accepted = 1 AND outcome = 'ACCEPTED_REPAIRED') OR (accepted = 0 AND outcome = 'TERMINAL_REJECTED')))),
  UNIQUE (generation_id, revision_id),
  UNIQUE (generation_id, attempt_number)
) STRICT;
CREATE TRIGGER review_semantic_attempt_owner BEFORE INSERT ON review_semantic_attempts BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM review_semantic_generations WHERE generation_id = NEW.generation_id
      AND (json_extract(NEW.record_json, '$.run_id') = run_id) IS TRUE
      AND (NEW.attempt_number != 1 OR created_operation_id = NEW.operation_id)
  ) THEN RAISE(ABORT, 'Semantic attempt requires its exact original run') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM review_semantic_terminals WHERE generation_id = NEW.generation_id
  ) THEN RAISE(ABORT, 'Semantic generation is already terminal') END;
  SELECT CASE WHEN NEW.attempt_number = 2 AND NOT EXISTS (
    SELECT 1 FROM review_semantic_attempts WHERE generation_id = NEW.generation_id AND attempt_number = 1 AND accepted = 0
  ) THEN RAISE(ABORT, 'Semantic repair requires its original rejected attempt') END;
END;
CREATE TABLE review_semantic_terminals (
  generation_id TEXT PRIMARY KEY REFERENCES review_semantic_generations(generation_id),
  terminal_attempt_revision_id TEXT NOT NULL UNIQUE,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  model_publication_id TEXT UNIQUE,
  model_relative_path TEXT UNIQUE,
  model_sha256 TEXT CHECK (model_sha256 IS NULL OR (length(model_sha256) = 64 AND model_sha256 NOT GLOB '*[^0-9a-f]*')),
  model_byte_length INTEGER CHECK (model_byte_length BETWEEN 0 AND 9007199254740991),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  status TEXT GENERATED ALWAYS AS (json_extract(manifest_json, '$.status')) STORED NOT NULL CHECK (status IN ('VALID', 'REJECTED')),
  CHECK ((json_extract(manifest_json, '$.schema_version') = 3) IS TRUE),
  CHECK ((json_extract(manifest_json, '$.generation_id') = generation_id) IS TRUE),
  CHECK ((status = 'VALID') = (model_publication_id IS NOT NULL)),
  CHECK ((model_publication_id IS NULL) = (model_relative_path IS NULL)),
  CHECK ((model_publication_id IS NULL) = (model_sha256 IS NULL)),
  CHECK ((model_publication_id IS NULL) = (model_byte_length IS NULL)),
  CHECK (model_relative_path IS NULL OR model_relative_path = 'evidence/' || model_publication_id || '/semantic-anchor-model-v3.json'),
  CHECK (json_extract(manifest_json, '$.model_sha256') IS model_sha256),
  FOREIGN KEY (generation_id, terminal_attempt_revision_id) REFERENCES review_semantic_attempts(generation_id, revision_id),
  UNIQUE (generation_id, status)
) STRICT;
CREATE TRIGGER review_semantic_terminal_owner BEFORE INSERT ON review_semantic_terminals BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM review_semantic_generations g JOIN review_semantic_attempts a ON a.generation_id = g.generation_id
    WHERE g.generation_id = NEW.generation_id AND a.revision_id = NEW.terminal_attempt_revision_id
      AND a.operation_id = NEW.operation_id
      AND (json_extract(NEW.manifest_json, '$.run_id') = g.run_id) IS TRUE
      AND (json_extract(NEW.manifest_json, '$.attempt_count') = a.attempt_number) IS TRUE
      AND (json_extract(NEW.manifest_json, '$.final_attempt_outcome') = a.outcome) IS TRUE
      AND ((json_extract(NEW.manifest_json, '$.status') = 'VALID' AND a.accepted = 1) OR
           (json_extract(NEW.manifest_json, '$.status') = 'REJECTED' AND a.accepted = 0 AND a.attempt_number = 2))
  ) THEN RAISE(ABORT, 'Semantic terminal requires its exact final attempt and run') END;
END;
CREATE TABLE review_semantic_current (
  review_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  terminal_status TEXT NOT NULL DEFAULT 'VALID' CHECK (terminal_status = 'VALID'),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (review_id, run_id),
  FOREIGN KEY (review_id, run_id, generation_id) REFERENCES review_semantic_generations(review_id, run_id, generation_id),
  FOREIGN KEY (generation_id, terminal_status) REFERENCES review_semantic_terminals(generation_id, status)
) STRICT;
CREATE TRIGGER review_semantic_current_initial BEFORE INSERT ON review_semantic_current BEGIN
  SELECT CASE WHEN NEW.version != 1 OR EXISTS (
    SELECT 1 FROM review_semantic_current WHERE review_id = NEW.review_id AND run_id = NEW.run_id
  ) THEN RAISE(ABORT, 'Semantic selection requires a new original selection') END;
END;
CREATE TRIGGER review_semantic_current_revision BEFORE UPDATE ON review_semantic_current BEGIN
  SELECT CASE WHEN NEW.review_id != OLD.review_id OR NEW.run_id != OLD.run_id OR NEW.version != OLD.version + 1
    THEN RAISE(ABORT, 'Semantic selection must preserve its owner and advance once') END;
END;
CREATE TRIGGER review_semantic_current_no_delete BEFORE DELETE ON review_semantic_current BEGIN
  SELECT RAISE(ABORT, 'Semantic selection is retained');
END;
${Object.entries(retainedKeys)
  .map(
    ([table, key]) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Semantic history is immutable');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Semantic history is retained');
END;
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${key}) BEGIN
  SELECT RAISE(ABORT, 'Semantic history is immutable');
END;`
  )
  .join('')}
`;
