const immutableTables = [
  [
    'source_plan_namespaces',
    'namespace_id=NEW.namespace_id OR (scope_kind=NEW.scope_kind AND server_url IS NEW.server_url AND org_id IS NEW.org_id AND account_id IS NEW.account_id AND original_locator_hash IS NEW.original_locator_hash)',
  ],
  ['source_plan_records', 'record_id=NEW.record_id'],
  [
    'source_plan_approved',
    '(namespace_id=NEW.namespace_id AND external_id=NEW.external_id AND approved_version=NEW.approved_version)',
  ],
  ['source_plan_locator_revisions', 'revision_id=NEW.revision_id'],
] as const;

export const PROJECT_SOURCE_PLAN_SCHEMA = `
CREATE TABLE source_plan_namespaces (
  namespace_id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('account','organization_observation','unresolved_upload')),
  server_url TEXT,
  org_id TEXT,
  account_id TEXT,
  original_namespace_hash TEXT CHECK (original_namespace_hash IS NULL OR (length(original_namespace_hash)=64 AND original_namespace_hash NOT GLOB '*[^0-9a-f]*')),
  original_locator_hash TEXT CHECK (original_locator_hash IS NULL OR (length(original_locator_hash)=64 AND original_locator_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK ((scope_kind='account' AND server_url IS NOT NULL AND length(server_url)>0 AND org_id IS NOT NULL AND length(org_id)>0 AND account_id IS NOT NULL AND length(account_id)>0 AND original_namespace_hash IS NULL AND original_locator_hash IS NULL)
    OR (scope_kind='organization_observation' AND server_url IS NOT NULL AND length(server_url)>0 AND org_id IS NOT NULL AND length(org_id)>0 AND account_id IS NULL AND original_namespace_hash IS NOT NULL AND original_locator_hash IS NULL)
    OR (scope_kind='unresolved_upload' AND server_url IS NULL AND org_id IS NULL AND account_id IS NULL AND original_namespace_hash IS NULL AND original_locator_hash IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX source_plan_account_namespace ON source_plan_namespaces(server_url,org_id,account_id) WHERE scope_kind='account';
CREATE UNIQUE INDEX source_plan_organization_namespace ON source_plan_namespaces(server_url,org_id) WHERE scope_kind='organization_observation';
CREATE UNIQUE INDEX source_plan_upload_namespace ON source_plan_namespaces(original_locator_hash) WHERE scope_kind='unresolved_upload';
CREATE TABLE source_plan_records (
  record_id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES source_plan_namespaces(namespace_id),
  kind TEXT NOT NULL CHECK (kind IN ('approved','candidate','proposal')),
  original_record_id TEXT CHECK (original_record_id IS NULL),
  record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  publication_operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  import_provenance_id TEXT CHECK (import_provenance_id IS NULL),
  record_sha256 TEXT NOT NULL CHECK (length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  external_id TEXT NOT NULL CHECK (length(external_id)>0),
  approved_version INTEGER CHECK (approved_version IS NULL OR approved_version BETWEEN 1 AND 9007199254740991),
  version_id TEXT CHECK (version_id IS NULL OR length(version_id)>0),
  version_number INTEGER CHECK (version_number IS NULL OR version_number BETWEEN 1 AND 9007199254740991),
  proposal_id TEXT CHECK (proposal_id IS NULL OR length(proposal_id)>0),
  base_version_number INTEGER CHECK (base_version_number IS NULL OR base_version_number BETWEEN 1 AND 9007199254740991),
  content_hash TEXT NOT NULL CHECK (length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  pulled_at TEXT NOT NULL CHECK (length(pulled_at)>0),
  CHECK ((kind='approved' AND approved_version IS NOT NULL AND version_id IS NULL AND version_number IS NULL AND proposal_id IS NULL AND base_version_number IS NULL)
    OR (kind='candidate' AND approved_version IS NULL AND version_id IS NOT NULL AND version_number IS NOT NULL AND proposal_id IS NULL)
    OR (kind='proposal' AND approved_version IS NULL AND version_id IS NULL AND version_number IS NULL AND proposal_id IS NOT NULL)),
  UNIQUE (namespace_id,record_id),
  UNIQUE (namespace_id,external_id,approved_version,record_id)
) STRICT;
CREATE INDEX source_plan_record_identity ON source_plan_records(namespace_id,kind,external_id,approved_version);
CREATE INDEX source_plan_proposal_identity ON source_plan_records(namespace_id,proposal_id) WHERE kind='proposal';
CREATE TRIGGER source_plan_record_account BEFORE INSERT ON source_plan_records
WHEN NOT EXISTS (SELECT 1 FROM source_plan_namespaces WHERE namespace_id=NEW.namespace_id AND scope_kind='account') BEGIN
  SELECT RAISE(ABORT, 'Authored Source Plan records require a known account namespace');
END;
CREATE TABLE source_plan_approved (
  namespace_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  approved_version INTEGER NOT NULL CHECK (approved_version BETWEEN 1 AND 9007199254740991),
  record_id TEXT NOT NULL,
  PRIMARY KEY (namespace_id,external_id,approved_version),
  UNIQUE (namespace_id,external_id,approved_version,record_id),
  FOREIGN KEY (namespace_id,external_id,approved_version,record_id) REFERENCES source_plan_records(namespace_id,external_id,approved_version,record_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER source_plan_approved_kind BEFORE INSERT ON source_plan_approved
WHEN NOT EXISTS (SELECT 1 FROM source_plan_records WHERE record_id=NEW.record_id AND namespace_id=NEW.namespace_id AND kind='approved' AND external_id=NEW.external_id AND approved_version=NEW.approved_version) BEGIN
  SELECT RAISE(ABORT, 'Approved selection requires the exact approved Source Plan record');
END;
CREATE TABLE source_plan_review_current (
  namespace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('candidate','proposal')),
  subject_id TEXT NOT NULL CHECK (length(subject_id)>0),
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (namespace_id,kind,subject_id),
  FOREIGN KEY (namespace_id,record_id) REFERENCES source_plan_records(namespace_id,record_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER source_plan_review_target_insert BEFORE INSERT ON source_plan_review_current
WHEN NOT EXISTS (SELECT 1 FROM source_plan_records WHERE record_id=NEW.record_id AND namespace_id=NEW.namespace_id AND kind=NEW.kind AND CASE NEW.kind WHEN 'candidate' THEN external_id ELSE proposal_id END=NEW.subject_id) BEGIN
  SELECT RAISE(ABORT, 'Source Plan review selection requires its exact original subject');
END;
CREATE TRIGGER source_plan_review_initial BEFORE INSERT ON source_plan_review_current
WHEN NEW.version<>1 BEGIN
  SELECT RAISE(ABORT, 'Source Plan review selection begins at version one');
END;
CREATE TRIGGER source_plan_review_no_replace BEFORE INSERT ON source_plan_review_current
WHEN EXISTS (SELECT 1 FROM source_plan_review_current WHERE namespace_id=NEW.namespace_id AND kind=NEW.kind AND subject_id=NEW.subject_id) BEGIN
  SELECT RAISE(ABORT, 'Source Plan review selection requires an exact version update');
END;
CREATE TRIGGER source_plan_review_transition BEFORE UPDATE ON source_plan_review_current
WHEN NEW.namespace_id<>OLD.namespace_id OR NEW.kind<>OLD.kind OR NEW.subject_id<>OLD.subject_id OR NEW.version<>OLD.version+1 OR NEW.record_id=OLD.record_id
  OR NOT EXISTS (SELECT 1 FROM source_plan_records n JOIN source_plan_records o ON o.record_id=OLD.record_id
    WHERE n.record_id=NEW.record_id AND n.namespace_id=NEW.namespace_id AND n.kind=NEW.kind
    AND CASE NEW.kind WHEN 'candidate' THEN n.external_id ELSE n.proposal_id END=NEW.subject_id
    AND n.external_id=o.external_id) BEGIN
  SELECT RAISE(ABORT, 'Source Plan review transition must preserve its subject and next version');
END;
CREATE TRIGGER source_plan_review_no_delete BEFORE DELETE ON source_plan_review_current BEGIN
  SELECT RAISE(ABORT, 'Source Plan review selection is retained');
END;
CREATE TABLE source_plan_locator_revisions (
  revision_id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES source_plan_namespaces(namespace_id),
  kind TEXT NOT NULL CHECK (kind IN ('path','upload')),
  record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  original_record_id TEXT CHECK (original_record_id IS NULL),
  publication_operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  import_provenance_id TEXT CHECK (import_provenance_id IS NULL),
  approved_record_id TEXT,
  record_sha256 TEXT NOT NULL CHECK (length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  real_path TEXT NOT NULL CHECK (length(real_path)>0),
  path_hash TEXT NOT NULL CHECK (length(path_hash)=64 AND path_hash NOT GLOB '*[^0-9a-f]*'),
  original_locator_hash TEXT CHECK (original_locator_hash IS NULL),
  external_id TEXT NOT NULL CHECK (length(external_id)>0),
  approved_version INTEGER CHECK (approved_version IS NULL OR approved_version BETWEEN 1 AND 9007199254740991),
  fingerprint TEXT CHECK (fingerprint IS NULL OR (length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*')),
  CHECK ((kind='path' AND approved_record_id IS NOT NULL AND approved_version IS NOT NULL AND fingerprint IS NULL)
    OR (kind='upload' AND approved_record_id IS NULL AND approved_version IS NULL AND fingerprint IS NOT NULL)),
  UNIQUE (namespace_id,kind,real_path,revision_id),
  FOREIGN KEY (namespace_id,external_id,approved_version,approved_record_id) REFERENCES source_plan_approved(namespace_id,external_id,approved_version,record_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX source_plan_locator_identity ON source_plan_locator_revisions(namespace_id,kind,real_path);
CREATE TRIGGER source_plan_locator_account BEFORE INSERT ON source_plan_locator_revisions
WHEN NOT EXISTS (SELECT 1 FROM source_plan_namespaces WHERE namespace_id=NEW.namespace_id AND scope_kind='account') BEGIN
  SELECT RAISE(ABORT, 'Authored Source Plan locators require a known account namespace');
END;
CREATE TRIGGER source_plan_record_family BEFORE INSERT ON source_plan_records
WHEN EXISTS (SELECT 1 FROM source_plan_locator_revisions WHERE revision_id=NEW.record_id) BEGIN
  SELECT RAISE(ABORT, 'Source Plan original revision identity cannot change families');
END;
CREATE TRIGGER source_plan_locator_family BEFORE INSERT ON source_plan_locator_revisions
WHEN EXISTS (SELECT 1 FROM source_plan_records WHERE record_id=NEW.revision_id) BEGIN
  SELECT RAISE(ABORT, 'Source Plan original revision identity cannot change families');
END;
CREATE TABLE source_plan_locator_current (
  namespace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('path','upload')),
  locator_kind TEXT NOT NULL CHECK (locator_kind='real_path'),
  locator TEXT NOT NULL CHECK (length(locator)>0),
  revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (namespace_id,kind,locator_kind,locator),
  FOREIGN KEY (namespace_id,kind,locator,revision_id) REFERENCES source_plan_locator_revisions(namespace_id,kind,real_path,revision_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER source_plan_locator_initial BEFORE INSERT ON source_plan_locator_current
WHEN NEW.version<>1 BEGIN
  SELECT RAISE(ABORT, 'Source Plan locator selection begins at version one');
END;
CREATE TRIGGER source_plan_locator_no_replace BEFORE INSERT ON source_plan_locator_current
WHEN EXISTS (SELECT 1 FROM source_plan_locator_current WHERE namespace_id=NEW.namespace_id AND kind=NEW.kind AND locator_kind=NEW.locator_kind AND locator=NEW.locator) BEGIN
  SELECT RAISE(ABORT, 'Source Plan locator selection requires an exact version update');
END;
CREATE TRIGGER source_plan_locator_transition BEFORE UPDATE ON source_plan_locator_current
WHEN NEW.namespace_id<>OLD.namespace_id OR NEW.kind<>OLD.kind OR NEW.locator_kind<>OLD.locator_kind OR NEW.locator<>OLD.locator OR NEW.version<>OLD.version+1 OR NEW.revision_id=OLD.revision_id BEGIN
  SELECT RAISE(ABORT, 'Source Plan locator transition requires its original path and next version');
END;
CREATE TRIGGER source_plan_locator_no_delete BEFORE DELETE ON source_plan_locator_current BEGIN
  SELECT RAISE(ABORT, 'Source Plan locator selection is retained');
END;
${immutableTables
  .map(
    ([table, collision]) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${collision}) BEGIN
  SELECT RAISE(ABORT, 'Source Plan history is immutable');
END;
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Source Plan history is immutable');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Source Plan history is retained');
END;`
  )
  .join('\n')}
`;
