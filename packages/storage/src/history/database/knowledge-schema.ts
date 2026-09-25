// Continuing knowledge: sources, subjects, requirements, task uses, recorded choices, approval
// bindings, exceptions, authorizations, conflict answers, assignments, revocations, correction
// actions and passage restatements, and
// the scheduling and control rows of background processing. Like the exact-revision family it extends, this
// family stores records and resolves nothing: what stands is computed by readers.
//
// An authored row keeps its payload once, as record_bytes. Every other column is a lookup copy
// that a constraint, an index or a reader needs, and the writer keeps it equal to the payload in
// the transaction that publishes both.
import {
  ATTRIBUTION_BASES,
  AUTHORIZATION_KINDS,
  firstRevisionGuard,
  insertOnlyGuards,
  INSTRUCTION_KINDS,
  retainedRecord,
  retainedRevision,
  sha256,
  SOURCE_STANDINGS,
} from './exact-revision-schema.js';

const RECORD_KINDS = "'requirement','decision','claim','relationship'";
const EXPECTATION_KINDS = "'requirement','decision'";
// A relationship states nothing of its own, so nothing can restate it.
const STATED_KINDS = "'requirement','decision','claim'";
const DEPARTURES = "'excepts','replaces','withdraws','corrects','stands_beside'";
const PROPOSING_CORRECTIONS =
  "'challenge','factual_correction','identity_correction','use_correction'";

const authored = `record_bytes BLOB NOT NULL CHECK (json_valid(CAST(record_bytes AS TEXT))),
  record_sha256 TEXT NOT NULL CHECK (${sha256('record_sha256')}),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED`;
const receipt = `operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED`;

const position = `position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991)`;
const named = (column: string) => `${column} TEXT NOT NULL CHECK (length(${column})>0)`;
const optional = (column: string) =>
  `${column} TEXT CHECK (${column} IS NULL OR length(${column})>0)`;

// Branch, worktree and task ownership grant no authority, so none of them is a scope here.
const scope = `scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project','artifact')),
  scope_value TEXT CHECK ((scope_kind='project' AND scope_value IS NULL) OR (scope_kind='artifact' AND scope_value IS NOT NULL AND length(scope_value)>0))`;

// An unknown actor has no name, and a named actor says how the name is known.
const actor = (column: string) => `${optional(column)},
  ${column}_basis TEXT NOT NULL CHECK (${column}_basis IN (${ATTRIBUTION_BASES}) AND (${column} IS NULL) = (${column}_basis='unknown'))`;

// A detector is always named and carries no basis; only an unknown actor has no name. The kind is
// compared with IS, because a CHECK passes when its expression is NULL and a missing kind has to
// be made false rather than left unknown.
const attributedAs = (
  kind: string,
  name: string,
  basis: string
) => `(${kind} IS 'detector' AND ${name} IS NOT NULL AND ${basis} IS NULL)
    OR (${kind} IS 'actor' AND ${basis} IS NOT NULL AND ${basis} IN (${ATTRIBUTION_BASES}) AND (${name} IS NULL) = (${basis}='unknown'))`;

const attribution = `attributed_kind TEXT NOT NULL CHECK (attributed_kind IN ('actor','detector')),
  ${optional('attributed_to')},
  attributed_basis TEXT CHECK (
    ${attributedAs('attributed_kind', 'attributed_to', 'attributed_basis')}
  )`;

// A relationship has no revisions of its own, so it is its own revision.
const revision = (
  prefix: string,
  kinds: string
) => `${prefix}_kind TEXT NOT NULL CHECK (${prefix}_kind IN (${kinds})),
  ${named(`${prefix}_id`)},
  ${prefix}_revision_id TEXT NOT NULL CHECK (length(${prefix}_revision_id)>0 AND (${prefix}_kind<>'relationship' OR ${prefix}_revision_id=${prefix}_id))`;

const optionalRevision = (
  prefix: string,
  kinds: string
) => `${prefix}_kind TEXT CHECK (${prefix}_kind IS NULL OR ${prefix}_kind IN (${kinds})),
  ${optional(`${prefix}_id`)},
  ${prefix}_revision_id TEXT CHECK (
    (${prefix}_kind IS NULL AND ${prefix}_id IS NULL AND ${prefix}_revision_id IS NULL)
    OR (${prefix}_kind IS NOT NULL AND ${prefix}_id IS NOT NULL AND ${prefix}_revision_id IS NOT NULL AND length(${prefix}_revision_id)>0 AND (${prefix}_kind<>'relationship' OR ${prefix}_revision_id=${prefix}_id))
  )`;

const tables = `
-- A capture field is named by its occurrence and owns no second copy of the bytes. Every other
-- source carries a content hash with its retained bytes or an immutable retained reference, so a
-- mutable URL alone can never be a source.
-- Who wrote it and who recorded it are people; who read a meaning into it is an actor or a
-- detector, because interpreting is what background processing does. All three columns absent is
-- a source nobody interpreted, which stays distinguishable from one a detector interpreted.
CREATE TABLE knowledge_sources (
  source_id TEXT PRIMARY KEY CHECK (length(source_id)>0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('capture_field','user_instruction','document_revision','review_comment','evaluator_result','external_reference')),
  artifact_id TEXT,
  event_id TEXT,
  ${optional('field_path')},
  position INTEGER CHECK (position IS NULL OR position BETWEEN 0 AND 9007199254740991),
  retention_kind TEXT CHECK (retention_kind IS NULL OR retention_kind IN ('bytes','retained_reference')),
  retained_bytes BLOB,
  ${optional('retained_reference')},
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR (${sha256('content_sha256')})),
  ${actor('source_author')},
  ${actor('recorded_by')},
  interpreted_kind TEXT CHECK (interpreted_kind IS NULL OR interpreted_kind IN ('actor','detector')),
  ${optional('interpreted_by')},
  interpreted_by_basis TEXT CHECK (
    (interpreted_kind IS NULL AND interpreted_by IS NULL AND interpreted_by_basis IS NULL)
    OR ${attributedAs('interpreted_kind', 'interpreted_by', 'interpreted_by_basis')}
  ),
  ${optional('access_restriction')},
  ${authored},
  CHECK (
    (source_kind='capture_field' AND artifact_id IS NOT NULL AND event_id IS NOT NULL AND field_path IS NOT NULL AND position IS NOT NULL
      AND retention_kind IS NULL AND retained_bytes IS NULL AND retained_reference IS NULL AND content_sha256 IS NULL)
    OR (source_kind<>'capture_field' AND artifact_id IS NULL AND event_id IS NULL AND field_path IS NULL AND position IS NULL
      AND content_sha256 IS NOT NULL AND retention_kind IS NOT NULL AND (
        (retention_kind='bytes' AND retained_bytes IS NOT NULL AND retained_reference IS NULL)
        OR (retention_kind='retained_reference' AND retained_bytes IS NULL AND retained_reference IS NOT NULL)
      ))
  ),
  FOREIGN KEY (artifact_id, event_id) REFERENCES artifact_events(artifact_id, event_id)
) STRICT;
-- One capture field occurrence is one source: a second source id for it would let the same
-- passage gain two identities.
CREATE UNIQUE INDEX knowledge_source_capture_occurrence ON knowledge_sources(event_id, field_path, position) WHERE source_kind='capture_field';
CREATE TABLE knowledge_interpretations (
  interpretation_id TEXT PRIMARY KEY CHECK (length(interpretation_id)>0),
  origin_source_id TEXT NOT NULL REFERENCES knowledge_sources(source_id) DEFERRABLE INITIALLY DEFERRED CHECK (length(origin_source_id)>0),
  origin_artifact_id TEXT,
  origin_plan_event_id TEXT,
  source_form TEXT NOT NULL CHECK (source_form IN ('stated_obligation','stated_decision','task_local_criterion','test_or_check','observation','question')),
  proposed_record_kind TEXT NOT NULL CHECK (proposed_record_kind IN ('requirement','decision','claim','none')),
  intended_scope_kind TEXT NOT NULL CHECK (intended_scope_kind IN ('project','artifact','unknown')),
  intended_scope_value TEXT,
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('none','exact_restatement','proposed_equivalence','candidate_revision')),
  target_kind TEXT CHECK (target_kind IS NULL OR target_kind IN ('requirement','decision','claim')),
  target_id TEXT CHECK (target_id IS NULL OR length(target_id)>0),
  target_revision_id TEXT CHECK (target_revision_id IS NULL OR length(target_revision_id)>0),
  attributed_kind TEXT NOT NULL CHECK (attributed_kind='detector'),
  attributed_to TEXT NOT NULL CHECK (length(attributed_to)>0),
  attributed_basis TEXT CHECK (attributed_basis IS NULL),
  ${authored},
  CHECK ((origin_artifact_id IS NULL) = (origin_plan_event_id IS NULL)),
  CHECK (
    (intended_scope_kind='artifact' AND intended_scope_value IS NOT NULL AND length(intended_scope_value)>0)
    OR (intended_scope_kind<>'artifact' AND intended_scope_value IS NULL)
  ),
  CHECK (
    (outcome_kind='none' AND target_kind IS NULL AND target_id IS NULL AND target_revision_id IS NULL)
    OR (outcome_kind<>'none' AND target_kind IS NOT NULL AND target_id IS NOT NULL AND target_revision_id IS NOT NULL)
  ),
  FOREIGN KEY (origin_artifact_id, origin_plan_event_id) REFERENCES artifact_events(artifact_id, event_id)
) STRICT;
CREATE INDEX knowledge_interpretation_origin ON knowledge_interpretations(origin_source_id);
CREATE INDEX knowledge_interpretation_task ON knowledge_interpretations(origin_artifact_id, origin_plan_event_id) WHERE origin_artifact_id IS NOT NULL;
CREATE INDEX knowledge_interpretation_scope ON knowledge_interpretations(intended_scope_kind, intended_scope_value);
CREATE INDEX knowledge_interpretation_target ON knowledge_interpretations(outcome_kind, target_kind, target_id, target_revision_id) WHERE target_kind IS NOT NULL;
CREATE TABLE knowledge_interpretation_evidence (
  interpretation_id TEXT NOT NULL REFERENCES knowledge_interpretations(interpretation_id) DEFERRABLE INITIALLY DEFERRED,
  ${position},
  source_id TEXT NOT NULL REFERENCES knowledge_sources(source_id) DEFERRABLE INITIALLY DEFERRED CHECK (length(source_id)>0),
  ${named('segment_id')},
  ${named('mapping_version')},
  mapping_sha256 TEXT NOT NULL CHECK (${sha256('mapping_sha256')}),
  prepared_sha256 TEXT NOT NULL CHECK (${sha256('prepared_sha256')}),
  prepared_start_utf8 INTEGER NOT NULL CHECK (prepared_start_utf8 BETWEEN 0 AND 9007199254740991),
  prepared_end_utf8 INTEGER NOT NULL CHECK (prepared_end_utf8 BETWEEN 1 AND 9007199254740991 AND prepared_end_utf8>prepared_start_utf8),
  original_ranges_json TEXT NOT NULL CHECK (json_valid(original_ranges_json)),
  quote TEXT NOT NULL CHECK (length(quote)>0),
  passage_sha256 TEXT NOT NULL CHECK (${sha256('passage_sha256')}),
  ${receipt},
  PRIMARY KEY (interpretation_id, position),
  UNIQUE (interpretation_id, source_id, segment_id, prepared_start_utf8, prepared_end_utf8, passage_sha256)
) STRICT;
CREATE INDEX knowledge_interpretation_evidence_source ON knowledge_interpretation_evidence(source_id, interpretation_id);
CREATE TABLE knowledge_equivalence_dispositions (
  disposition_id TEXT PRIMARY KEY CHECK (length(disposition_id)>0),
  interpretation_id TEXT NOT NULL UNIQUE REFERENCES knowledge_interpretations(interpretation_id),
  disposition TEXT NOT NULL CHECK (disposition='rejected'),
  ${actor('decided_by')},
  ${authored}
) STRICT;
CREATE TABLE subjects (
  subject_id TEXT PRIMARY KEY CHECK (length(subject_id)>0),
  first_revision_id TEXT NOT NULL,
  ${receipt},
  UNIQUE (subject_id, first_revision_id),
  FOREIGN KEY (subject_id, first_revision_id) REFERENCES subject_revisions(subject_id, revision_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE subject_revisions (
  revision_id TEXT PRIMARY KEY CHECK (length(revision_id)>0),
  subject_id TEXT NOT NULL REFERENCES subjects(subject_id) DEFERRABLE INITIALLY DEFERRED,
  previous_revision_id TEXT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('capability','service','api','workflow','project','other')),
  ${actor('authored_by')},
  ${authored},
  UNIQUE (subject_id, revision_id),
  CHECK (previous_revision_id IS NULL OR previous_revision_id<>revision_id),
  FOREIGN KEY (subject_id, previous_revision_id) REFERENCES subject_revisions(subject_id, revision_id)
) STRICT;
-- A promoted criterion's requirement is that criterion, so it keeps the criterion's id; a
-- different proposition derived from a criterion or an expectation never shares that id. The
-- criterion itself lives inside its plan event's bytes, so the reference reaches the event and
-- the writer finds the criterion in it.
CREATE TABLE requirements (
  requirement_id TEXT PRIMARY KEY CHECK (length(requirement_id)>0),
  first_revision_id TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('promoted_criterion','promoted_source','derived','authored','interpreted_source')),
  derived_from_kind TEXT CHECK (derived_from_kind IS NULL OR derived_from_kind IN ('criterion','expectation')),
  criterion_artifact_id TEXT,
  criterion_plan_event_id TEXT,
  ${optional('criterion_id')},
  ${optionalRevision('expectation', EXPECTATION_KINDS)},
  passage_source_id TEXT REFERENCES knowledge_sources(source_id) DEFERRABLE INITIALLY DEFERRED CHECK (passage_source_id IS NULL OR length(passage_source_id)>0),
  ${optional('passage_location')},
  passage_sha256 TEXT CHECK (passage_sha256 IS NULL OR (${sha256('passage_sha256')})),
  interpretation_id TEXT REFERENCES knowledge_interpretations(interpretation_id) DEFERRABLE INITIALLY DEFERRED CHECK (interpretation_id IS NULL OR length(interpretation_id)>0),
  ${authored},
  UNIQUE (requirement_id, first_revision_id),
  CHECK ((criterion_id IS NULL) = (criterion_artifact_id IS NULL) AND (criterion_id IS NULL) = (criterion_plan_event_id IS NULL)),
  CHECK ((passage_source_id IS NULL) = (passage_location IS NULL) AND (passage_source_id IS NULL) = (passage_sha256 IS NULL)),
  CHECK (
    (origin_kind='promoted_criterion' AND derived_from_kind IS NULL AND criterion_id IS NOT NULL AND criterion_id=requirement_id AND expectation_kind IS NULL AND passage_source_id IS NULL AND interpretation_id IS NULL)
    OR (origin_kind='promoted_source' AND derived_from_kind IS NULL AND criterion_id IS NULL AND expectation_kind IS NULL AND passage_source_id IS NOT NULL AND interpretation_id IS NULL)
    OR (origin_kind='derived' AND derived_from_kind IS 'criterion' AND criterion_id IS NOT NULL AND criterion_id<>requirement_id AND expectation_kind IS NULL AND passage_source_id IS NULL AND interpretation_id IS NULL)
    OR (origin_kind='derived' AND derived_from_kind IS 'expectation' AND criterion_id IS NULL AND expectation_id IS NOT NULL AND expectation_id<>requirement_id AND passage_source_id IS NULL AND interpretation_id IS NULL)
    OR (origin_kind='authored' AND derived_from_kind IS NULL AND criterion_id IS NULL AND expectation_kind IS NULL AND passage_source_id IS NULL AND interpretation_id IS NULL)
    OR (origin_kind='interpreted_source' AND derived_from_kind IS NULL AND criterion_id IS NULL AND expectation_kind IS NULL AND passage_source_id IS NULL AND interpretation_id IS NOT NULL)
  ),
  FOREIGN KEY (requirement_id, first_revision_id) REFERENCES requirement_revisions(requirement_id, revision_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (criterion_artifact_id, criterion_plan_event_id) REFERENCES artifact_events(artifact_id, event_id)
) STRICT;
-- One passage never gets two identities: an existing requirement is reached by a revision that
-- restates the passage, never by promoting it again.
CREATE UNIQUE INDEX requirement_promoted_passage ON requirements(passage_source_id, passage_location, passage_sha256) WHERE origin_kind='promoted_source';
CREATE UNIQUE INDEX requirement_interpreted_source ON requirements(interpretation_id) WHERE origin_kind='interpreted_source';
CREATE TABLE requirement_revisions (
  revision_id TEXT PRIMARY KEY CHECK (length(revision_id)>0),
  requirement_id TEXT NOT NULL REFERENCES requirements(requirement_id) DEFERRABLE INITIALLY DEFERRED,
  previous_revision_id TEXT,
  subject_id TEXT,
  subject_revision_id TEXT,
  source_standing TEXT NOT NULL CHECK (source_standing IN (${SOURCE_STANDINGS})),
  duration_kind TEXT NOT NULL CHECK (duration_kind IN ('continuing','until_time','until_condition','unknown')),
  ${attribution},
  ${authored},
  UNIQUE (requirement_id, revision_id),
  CHECK (previous_revision_id IS NULL OR previous_revision_id<>revision_id),
  CHECK ((subject_id IS NULL) = (subject_revision_id IS NULL)),
  CHECK (attributed_kind<>'detector' OR source_standing='extracted_candidate'),
  FOREIGN KEY (requirement_id, previous_revision_id) REFERENCES requirement_revisions(requirement_id, revision_id),
  FOREIGN KEY (subject_id, subject_revision_id) REFERENCES subject_revisions(subject_id, revision_id)
) STRICT;
CREATE INDEX requirement_revision_subject ON requirement_revisions(subject_id, requirement_id) WHERE subject_id IS NOT NULL;
-- Keyed to the immutable plan event, so a checkpoint inherits the uses of the plan revision it
-- opened against. selection_kind says whether the plan event's own operation wrote the row; the
-- writer derives it from the two operations and never takes it from its caller. Finding a
-- connection after the task is what background processing does, so the discoverer is an actor or
-- a detector and never a detector's name in a column meant for a person.
CREATE TABLE task_uses (
  artifact_id TEXT NOT NULL,
  plan_event_id TEXT NOT NULL,
  ${revision('target', EXPECTATION_KINDS)},
  role TEXT NOT NULL CHECK (role IN ('implement','preserve','assess','background','propose_change')),
  ${optional('step_id')},
  criterion_id TEXT CHECK (criterion_id IS NULL OR (length(criterion_id)>0 AND step_id IS NOT NULL)),
  exception_id TEXT REFERENCES knowledge_exceptions(exception_id),
  selection_kind TEXT NOT NULL CHECK (selection_kind IN ('selected_with_plan','connected_later')),
  ${optional('discovered_at')},
  discovered_kind TEXT CHECK (discovered_kind IS NULL OR discovered_kind IN ('actor','detector')),
  ${optional('discovered_by')},
  discovered_by_basis TEXT CHECK (
    (selection_kind='selected_with_plan' AND discovered_at IS NULL AND discovered_kind IS NULL AND discovered_by IS NULL AND discovered_by_basis IS NULL)
    OR (selection_kind='connected_later' AND discovered_at IS NOT NULL AND (
      ${attributedAs('discovered_kind', 'discovered_by', 'discovered_by_basis')}
    ))
  ),
  ${authored},
  FOREIGN KEY (artifact_id, plan_event_id) REFERENCES artifact_events(artifact_id, event_id)
) STRICT;
-- The local step, the criterion and the exception are each optional, and SQLite treats NULLs in
-- a unique index as distinct. No identifier is empty, so '' stands for an absent one. A repeat
-- is never a new act: a use correction names the plan event and the target, not a row, so the
-- same use recorded again would fall under it all the same, and undoing it is a reversal.
CREATE UNIQUE INDEX task_use_identity ON task_uses(plan_event_id, target_kind, target_revision_id, role, ifnull(step_id,''), ifnull(criterion_id,''), ifnull(exception_id,''));
CREATE INDEX task_use_target ON task_uses(target_kind, target_id, target_revision_id);
-- A working or final recorded choice adopts nothing. An accepted selection is an adoption and
-- lives in adoptions, so neither table can be read as the other.
CREATE TABLE recorded_choices (
  selection_id TEXT PRIMARY KEY CHECK (length(selection_id)>0),
  selection_kind TEXT NOT NULL CHECK (selection_kind IN ('working','final_recorded')),
  ${revision('target', RECORD_KINDS)},
  ${scope},
  ${actor('selected_by')},
  ${authored}
) STRICT;
CREATE INDEX recorded_choice_target ON recorded_choices(target_kind, target_id, target_revision_id);
-- A binding with no targets is a plan approved as a plan: it adopts nothing.
CREATE TABLE approval_bindings (
  binding_id TEXT PRIMARY KEY CHECK (length(binding_id)>0),
  ${named('source_plan_ref')},
  ${named('approved_version')},
  plan_content_sha256 TEXT NOT NULL CHECK (${sha256('plan_content_sha256')}),
  ${actor('approved_by')},
  ${named('authorization_evidence_source_id')},
  ${authored}
) STRICT;
CREATE INDEX approval_binding_approval ON approval_bindings(source_plan_ref, approved_version, plan_content_sha256);
-- A bound revision may be approved before this store holds it, so only the binding is a
-- reference here; a writer that acts on the binding requires the revision.
CREATE TABLE approval_binding_targets (
  binding_id TEXT NOT NULL REFERENCES approval_bindings(binding_id),
  ${position},
  bound_kind TEXT NOT NULL CHECK (bound_kind IN ('revision','source_selector')),
  ${optionalRevision('target', RECORD_KINDS)},
  ${optional('selector_source_id')},
  ${optional('selector_location')},
  selector_passage_sha256 TEXT CHECK (selector_passage_sha256 IS NULL OR (${sha256('selector_passage_sha256')})),
  ${scope},
  designation TEXT NOT NULL CHECK (designation IN ('adopted','background')),
  ${receipt},
  PRIMARY KEY (binding_id, position),
  CHECK (
    (bound_kind='revision' AND target_kind IS NOT NULL AND selector_source_id IS NULL AND selector_location IS NULL AND selector_passage_sha256 IS NULL)
    OR (bound_kind='source_selector' AND target_kind IS NULL AND selector_source_id IS NOT NULL AND selector_location IS NOT NULL AND selector_passage_sha256 IS NOT NULL)
  )
) STRICT;
-- One target in one scope is bound once, so a binding never says both adopted and background
-- about the same thing. '' stands for the absent half of the target and for project scope.
CREATE UNIQUE INDEX approval_binding_target_identity ON approval_binding_targets(binding_id, scope_kind, ifnull(scope_value,''), bound_kind, ifnull(target_kind,''), ifnull(target_revision_id,''), ifnull(selector_source_id,''), ifnull(selector_location,''), ifnull(selector_passage_sha256,''));
-- Exactly the departures the approver was shown, per scope. An exception is named before it
-- exists, because the exception is published under this binding, so exception_id references
-- nothing.
CREATE TABLE approval_binding_departures (
  binding_id TEXT NOT NULL REFERENCES approval_bindings(binding_id),
  ${position},
  ${scope},
  ${revision('rule', EXPECTATION_KINDS)},
  how TEXT NOT NULL CHECK (how IN (${DEPARTURES})),
  exception_id TEXT CHECK ((how='excepts') = (exception_id IS NOT NULL) AND (exception_id IS NULL OR length(exception_id)>0)),
  ${optionalRevision('replaced_by', RECORD_KINDS)},
  ${receipt},
  PRIMARY KEY (binding_id, position),
  CHECK ((how='replaces') = (replaced_by_kind IS NOT NULL))
) STRICT;
CREATE INDEX approval_binding_departure_rule ON approval_binding_departures(rule_kind, rule_id, rule_revision_id);
-- Nothing ends a resolution and its binding fixes the designation, so a second row for the same
-- binding, selector, scope and revision could only repeat the first.
CREATE TABLE selector_resolutions (
  binding_id TEXT NOT NULL REFERENCES approval_bindings(binding_id),
  ${named('selector_source_id')},
  ${named('selector_location')},
  selector_passage_sha256 TEXT NOT NULL CHECK (${sha256('selector_passage_sha256')}),
  ${revision('resolved', RECORD_KINDS)},
  ${scope},
  designation TEXT NOT NULL CHECK (designation IN ('adopted','background')),
  ${authored},
  UNIQUE (binding_id, selector_source_id, selector_location, selector_passage_sha256, resolved_kind, resolved_revision_id, scope_kind, scope_value)
) STRICT;
CREATE UNIQUE INDEX selector_resolution_project_identity ON selector_resolutions(binding_id, selector_source_id, selector_location, selector_passage_sha256, resolved_kind, resolved_revision_id) WHERE scope_kind='project';
CREATE INDEX selector_resolution_passage ON selector_resolutions(selector_source_id, selector_location, selector_passage_sha256);
-- An ending writes nothing: a reader computes an exception's standing from ends and the
-- revocations that name it.
CREATE TABLE knowledge_exceptions (
  exception_id TEXT PRIMARY KEY CHECK (length(exception_id)>0),
  ${revision('expectation', EXPECTATION_KINDS)},
  ${scope},
  ${actor('granted_by')},
  authorization_kind TEXT NOT NULL CHECK (authorization_kind IN (${AUTHORIZATION_KINDS})),
  end_kind TEXT NOT NULL CHECK (end_kind IN ('until_time','until_condition','until_revoked','unknown')),
  end_behavior TEXT NOT NULL CHECK (end_behavior IN ('expectation_applies_again','review_required','none_recorded')),
  ${authored},
  CHECK (end_kind NOT IN ('until_time','until_condition') OR end_behavior<>'none_recorded')
) STRICT;
CREATE INDEX knowledge_exception_expectation ON knowledge_exceptions(expectation_kind, expectation_id, expectation_revision_id);
-- What a reused authorization cites. The footprint it authorized and its work context stay in
-- record_bytes: they are read whole and never looked up by member.
CREATE TABLE knowledge_authorizations (
  authorization_id TEXT PRIMARY KEY CHECK (length(authorization_id)>0),
  instruction_kind TEXT NOT NULL CHECK (instruction_kind IN (${INSTRUCTION_KINDS})),
  instruction_source_id TEXT NOT NULL REFERENCES knowledge_sources(source_id) DEFERRABLE INITIALLY DEFERRED CHECK (length(instruction_source_id)>0),
  ${scope},
  ${actor('granted_by')},
  ${authored}
) STRICT;
-- Kept either way: a refusal is what stops the same change being asked again.
CREATE TABLE conflict_answers (
  answer_id TEXT PRIMARY KEY CHECK (length(answer_id)>0),
  ${revision('rule', EXPECTATION_KINDS)},
  outcome TEXT NOT NULL CHECK (outcome IN ('authorized','declined')),
  ${scope},
  ${actor('answered_by')},
  authorization_id TEXT REFERENCES knowledge_authorizations(authorization_id) CHECK ((outcome='authorized') = (authorization_id IS NOT NULL)),
  ${authored}
) STRICT;
CREATE INDEX conflict_answer_rule ON conflict_answers(rule_kind, rule_id, rule_revision_id);
-- Who may decide what on somebody's behalf. The objective is the one line a listing shows, and the
-- rest of the record — the obligations it inherits, the footprint it delegates, what it allows and
-- when to escalate in the assigner's own words — stays in record_bytes and is read whole. Nothing
-- ends an assignment in place: a reader computes its standing from valid_until and the revocations
-- that name it, exactly as it does for an exception.
CREATE TABLE assignments (
  assignment_id TEXT PRIMARY KEY CHECK (length(assignment_id)>0),
  ${named('objective')},
  ${actor('responsible')},
  ${actor('assigned_by')},
  ${scope},
  authorization_kind TEXT NOT NULL CHECK (authorization_kind IN (${AUTHORIZATION_KINDS})),
  source_id TEXT NOT NULL REFERENCES knowledge_sources(source_id) DEFERRABLE INITIALLY DEFERRED CHECK (length(source_id)>0),
  ${optional('valid_until')},
  ${authored},
  -- Delegating to nobody in particular delegates to nobody: an act is judged on whether it claims
  -- the responsible identity, and an unnamed one is never claimed.
  CHECK (responsible IS NOT NULL)
) STRICT;
CREATE INDEX assignment_responsible ON assignments(responsible, assignment_id);
-- The identities an assignment names, whether it inherits an obligation about one or delegates a
-- change to it. One row per identity, because both readers that need it — the lookup's per-identity
-- answer and the owner rule — ask by identity and never by revision. It is how a reader also finds
-- the acts that rested on an assignment: every such act lies inside the delegated footprint, so its
-- identity is named here, and each act's own authorization JSON names the assignment.
CREATE TABLE assignment_members (
  assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id) DEFERRABLE INITIALLY DEFERRED,
  ${named('member_kind')},
  ${named('member_id')},
  ${receipt},
  PRIMARY KEY (assignment_id, member_kind, member_id),
  CHECK (member_kind IN (${RECORD_KINDS}))
) STRICT;
CREATE INDEX assignment_member_identity ON assignment_members(member_kind, member_id, assignment_id);
CREATE TABLE knowledge_revocations (
  revocation_id TEXT PRIMARY KEY CHECK (length(revocation_id)>0),
  revoked_kind TEXT NOT NULL CHECK (revoked_kind IN ('authorization','exception','conflict_answer','assignment')),
  ${named('revoked_id')},
  ${scope},
  ${actor('revoked_by')},
  instruction_kind TEXT NOT NULL CHECK (instruction_kind IN (${INSTRUCTION_KINDS})),
  ${authored}
) STRICT;
CREATE INDEX knowledge_revocation_target ON knowledge_revocations(revoked_kind, revoked_id);
-- Appended; originals survive. follows_action_id is the action a reversal or an acceptance
-- follows, and adopted_* the replacement or restored revision the action makes stand: a
-- replacement is itself the record that adopts, and no selection follows it. change_class and
-- changed_what_stands keep what the store judged when it appended the action, so the governing
-- state of a target is read from rows and no footprint is recomputed over payload chains. A
-- detector proposes and a proposal authorizes nothing: only an actor changes what stands.
-- authorization_kind is what the act cited; authorization_id is the authorization record written
-- for this very act, which is how a revocation of it reaches what was published under it. Only an
-- act published under an embedded instruction records one, so an id under anything else is
-- refused and a proposal names neither. Unlike the shared fragment this stops at that one
-- direction: a reversal of somebody else's proposal is published on an instruction and adopts,
-- departs from and restates nothing, and an authorization over an empty footprint is one the
-- contract refuses, so an act under an instruction may leave the column empty.
CREATE TABLE correction_actions (
  action_id TEXT PRIMARY KEY CHECK (length(action_id)>0),
  action_kind TEXT NOT NULL CHECK (action_kind IN (${PROPOSING_CORRECTIONS},'acceptance','withdrawal','accepted_replacement','reversal')),
  ${scope},
  ${attribution},
  authorization_kind TEXT CHECK (authorization_kind IS NULL OR authorization_kind IN (${AUTHORIZATION_KINDS})),
  authorization_id TEXT REFERENCES knowledge_authorizations(authorization_id) CHECK (authorization_id IS NULL OR length(authorization_id)>0),
  follows_action_id TEXT REFERENCES correction_actions(action_id) CHECK (follows_action_id IS NULL OR follows_action_id<>action_id),
  resulting_selection_kind TEXT CHECK (resulting_selection_kind IS NULL OR resulting_selection_kind IN ('revision','none')),
  ${optionalRevision('adopted', RECORD_KINDS)},
  adopted_designation TEXT CHECK ((adopted_kind IS NULL AND adopted_designation IS NULL) OR (adopted_kind IS NOT NULL AND adopted_designation IS NOT NULL AND adopted_designation IN ('adopted','background'))),
  change_class TEXT NOT NULL CHECK (change_class IN ('intent_change','factual_correction','proposal')),
  changed_what_stands INTEGER NOT NULL CHECK (changed_what_stands IN (0, 1)),
  ${authored},
  CHECK ((action_kind IN ('acceptance','reversal')) = (follows_action_id IS NOT NULL)),
  CHECK ((action_kind='reversal') = (resulting_selection_kind IS NOT NULL)),
  CHECK ((action_kind='accepted_replacement' OR resulting_selection_kind IS 'revision') = (adopted_kind IS NOT NULL)),
  CHECK (action_kind IN (${PROPOSING_CORRECTIONS}) OR attributed_kind='actor'),
  CHECK (action_kind NOT IN (${PROPOSING_CORRECTIONS}) OR (authorization_kind IS NULL AND authorization_id IS NULL AND changed_what_stands=0)),
  CHECK (authorization_id IS NULL OR coalesce(authorization_kind IN (${INSTRUCTION_KINDS}), 0))
) STRICT;
CREATE INDEX correction_action_followers ON correction_actions(follows_action_id) WHERE follows_action_id IS NOT NULL;
CREATE INDEX correction_action_adopted ON correction_actions(adopted_kind, adopted_id) WHERE adopted_kind IS NOT NULL;
CREATE INDEX correction_action_authorization ON correction_actions(authorization_id) WHERE authorization_id IS NOT NULL;
CREATE TABLE correction_targets (
  action_id TEXT NOT NULL REFERENCES correction_actions(action_id),
  ${position},
  ${revision('target', RECORD_KINDS)},
  ${receipt},
  PRIMARY KEY (action_id, position)
) STRICT;
CREATE INDEX correction_target_revision ON correction_targets(target_kind, target_id, target_revision_id, action_id);
-- A passage that states, word for word, what a revision already says. It is no revision of
-- anything and changes nothing that stands, so it carries neither a standing nor an
-- authorization. What it records is the second retained occurrence of the same words, which is
-- what a repeated capture really adds. One passage restates one revision once: nothing ends a
-- restatement and there is no standing in it for a later act to raise, so a second row for the
-- same pair could only repeat the first and would be counted as corroboration twice.
CREATE TABLE passage_restatements (
  restatement_id TEXT PRIMARY KEY CHECK (length(restatement_id)>0),
  passage_source_id TEXT NOT NULL REFERENCES knowledge_sources(source_id) DEFERRABLE INITIALLY DEFERRED CHECK (length(passage_source_id)>0),
  ${named('passage_location')},
  passage_sha256 TEXT NOT NULL CHECK (${sha256('passage_sha256')}),
  restates_kind TEXT NOT NULL CHECK (restates_kind IN (${STATED_KINDS})),
  ${named('restates_id')},
  ${named('restates_revision_id')},
  ${attribution},
  ${authored},
  UNIQUE (passage_source_id, passage_location, passage_sha256, restates_kind, restates_revision_id)
) STRICT;
CREATE INDEX passage_restatement_revision ON passage_restatements(restates_kind, restates_id, restates_revision_id);
-- The observations a finding rests on, which is where its producer, method, configuration,
-- execution context, input identities and limits live. The observation table is created after this
-- one, so the reference is deferred as the rest of the family's are.
CREATE TABLE claim_revision_observations (
  revision_id TEXT NOT NULL REFERENCES claim_revisions(revision_id) DEFERRABLE INITIALLY DEFERRED,
  ${position},
  observation_id TEXT NOT NULL REFERENCES knowledge_observations(observation_id) DEFERRABLE INITIALLY DEFERRED CHECK (length(observation_id)>0),
  ${receipt},
  PRIMARY KEY (revision_id, position)
) STRICT;
CREATE INDEX claim_revision_observation_lookup ON claim_revision_observations(observation_id);
`;

// Scheduling rows are maintenance data: a claim, a heartbeat or a reservation carries no
// receipt and moves neither project counter, so processing can never invalidate itself. Only a
// job's admission belongs to an operation, the one that published its source.
//
// A job, an attempt and a reservation each carry facts settled at insert, named by the table's
// fixed_facts guard; every other column is scheduling state. One source and processor contract
// is one job, so a replay admits no second one, and a job numbers its attempts as it makes them,
// so a repeated number would be a lost attempt rather than a later one. A job's no-model choice
// is a fixed fact. The model_resume columns retain the first confirmation as a compatibility
// audit marker; only the append-only confirmation rows authorize scheduling. An attempt names
// the consent grant it runs under as a fixed fact of its own, so a
// grant can be revalidated and a revoked one's work found by lookup. An attempt's
// publishing_operation_id is the operation that published what the attempt derived; it is set when
// the attempt settles and, like everything else in a settled attempt, fixed afterwards. A
// reopening is a person's act on a job that gave up: it keeps the result it set aside, where the
// earlier attempts end and the allowance the person approved, and only attempts numbered after it
// count against that allowance. Reopenings are numbered in the order they happen, so the latest by
// sequence is the one every allowance reader takes.
const scheduling = `
CREATE TABLE processing_jobs (
  job_id TEXT PRIMARY KEY CHECK (length(job_id)>0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('capture_event','knowledge_source')),
  ${named('source_id')},
  ${named('processor_contract')},
  admitting_operation_id TEXT NOT NULL REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  admission_json TEXT NOT NULL CHECK (json_valid(admission_json)),
  without_model INTEGER NOT NULL CHECK (without_model IN (0, 1)),
  ${named('admitted_at')},
  state TEXT NOT NULL CHECK (state IN ('pending','running','completed','retryable_failure','terminal_failure')),
  ${optional('wait_reason')},
  ${optional('retry_at')},
  claimed_generation INTEGER CHECK ((state='running') = (claimed_generation IS NOT NULL) AND (claimed_generation IS NULL OR claimed_generation BETWEEN 1 AND 9007199254740991)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  ${optional('model_resumed_at')},
  ${optional('model_resumed_by')},
  model_resumed_by_basis TEXT CHECK (model_resumed_by_basis IS NULL OR model_resumed_by_basis IN (${ATTRIBUTION_BASES})),
  ${optional('model_resume_grant_id')},
  ${named('updated_at')},
  UNIQUE (source_kind, source_id, processor_contract),
  CHECK (
    (model_resumed_at IS NULL AND model_resumed_by IS NULL AND model_resumed_by_basis IS NULL AND model_resume_grant_id IS NULL)
    OR (without_model=1 AND model_resumed_at IS NOT NULL AND model_resume_grant_id IS NOT NULL AND model_resumed_by_basis IS NOT NULL AND (model_resumed_by IS NULL) = (model_resumed_by_basis='unknown'))
  )
) STRICT;
CREATE INDEX processing_job_queue ON processing_jobs(state, retry_at, job_id);
CREATE TABLE processing_model_confirmations (
  confirmation_id TEXT PRIMARY KEY CHECK (length(confirmation_id)>0),
  job_id TEXT NOT NULL REFERENCES processing_jobs(job_id),
  confirmation_sequence INTEGER NOT NULL CHECK (confirmation_sequence BETWEEN 1 AND 9007199254740991),
  ${named('confirmed_at')},
  ${actor('confirmed_by')},
  ${named('grant_id')},
  terms_json TEXT NOT NULL CHECK (json_valid(terms_json)),
  UNIQUE (job_id, confirmation_sequence)
) STRICT;
CREATE TABLE processing_job_reopenings (
  reopening_id TEXT PRIMARY KEY CHECK (length(reopening_id)>0),
  job_id TEXT NOT NULL REFERENCES processing_jobs(job_id),
  reopening_sequence INTEGER NOT NULL CHECK (reopening_sequence BETWEEN 1 AND 9007199254740991),
  attempts_before INTEGER NOT NULL CHECK (attempts_before BETWEEN 0 AND 9007199254740991),
  attempts_allowed INTEGER NOT NULL CHECK (attempts_allowed BETWEEN 1 AND 9007199254740991),
  gave_up_json TEXT NOT NULL CHECK (json_valid(gave_up_json)),
  ${named('grant_id')},
  ${named('reopened_at')},
  ${actor('reopened_by')},
  UNIQUE (job_id, reopening_sequence)
) STRICT;
CREATE TABLE processing_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id)>0),
  job_id TEXT NOT NULL REFERENCES processing_jobs(job_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 9007199254740991),
  owner_generation INTEGER NOT NULL CHECK (owner_generation BETWEEN 1 AND 9007199254740991),
  configuration_sha256 TEXT NOT NULL CHECK (${sha256('configuration_sha256')}),
  configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
  ${named('grant_id')},
  ${named('started_at')},
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded','failed','unknown')),
  finished_at TEXT CHECK ((outcome IS NULL) = (finished_at IS NULL)),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  process_json TEXT CHECK (process_json IS NULL OR json_valid(process_json)),
  publishing_operation_id TEXT REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED CHECK (publishing_operation_id IS NULL OR outcome IS NOT NULL),
  UNIQUE (job_id, attempt_number)
) STRICT;
CREATE INDEX processing_attempt_unsettled ON processing_attempts(job_id) WHERE outcome IS NULL;
-- Revalidating a grant at dispatch and settlement, and cancelling what a revoked one authorized,
-- are lookups by grant, so consent is a column of its own and not a member of a payload.
CREATE INDEX processing_attempt_grant ON processing_attempts(grant_id);
CREATE TABLE processing_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_generation INTEGER NOT NULL CHECK (owner_generation BETWEEN 1 AND 9007199254740991),
  ${optional('owner_id')},
  acquired_at TEXT,
  renewed_at TEXT,
  expires_at TEXT CHECK ((owner_id IS NULL) = (acquired_at IS NULL) AND (owner_id IS NULL) = (renewed_at IS NULL) AND (owner_id IS NULL) = (expires_at IS NULL))
) STRICT;
CREATE TABLE processing_usage (
  usage_id TEXT PRIMARY KEY CHECK (length(usage_id)>0),
  attempt_id TEXT NOT NULL REFERENCES processing_attempts(attempt_id),
  ${named('reserved_at')},
  reserved_cost_usd REAL CHECK (reserved_cost_usd IS NULL OR reserved_cost_usd>=0),
  state TEXT NOT NULL CHECK (state IN ('reserved','settled','released','unknown')),
  settled_at TEXT CHECK ((state='reserved') = (settled_at IS NULL)),
  reported_cost_usd REAL CHECK (reported_cost_usd IS NULL OR (reported_cost_usd>=0 AND state='settled')),
  usage_json TEXT CHECK (usage_json IS NULL OR (json_valid(usage_json) AND state='settled'))
) STRICT;
CREATE INDEX processing_usage_window ON processing_usage(reserved_at, state);
CREATE INDEX processing_usage_attempt ON processing_usage(attempt_id);
-- The project-wide pause outlives any worker and has a row of its own, so pausing and resuming
-- never rewrite a job. No row means processing was never paused here.
CREATE TABLE processing_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  ${named('changed_at')},
  ${actor('changed_by')},
  ${optional('reason')}
) STRICT;
`;

const requires = (
  trigger: string,
  table: string,
  condition: string,
  present: string,
  message: string
) => `
CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table}
WHEN ${condition}NOT EXISTS (${present}
) BEGIN
  SELECT RAISE(ABORT, '${message}');
END;`;

const record = (prefix: string) =>
  retainedRecord(`NEW.${prefix}_kind`, `NEW.${prefix}_id`, `NEW.${prefix}_revision_id`);
const expectation = (prefix: string) =>
  retainedRevision(`NEW.${prefix}_kind`, `NEW.${prefix}_id`, `NEW.${prefix}_revision_id`);

const references = [
  requires(
    'knowledge_interpretation_requires_plan_event',
    'knowledge_interpretations',
    'NEW.origin_plan_event_id IS NOT NULL AND ',
    `
  SELECT 1 FROM artifact_events WHERE artifact_id=NEW.origin_artifact_id AND event_id=NEW.origin_plan_event_id AND event_type IN ('plan_captured','plan_revised')`,
    'An interpretation task origin is an exact retained plan event'
  ),
  requires(
    'knowledge_interpretation_requires_target',
    'knowledge_interpretations',
    "NEW.outcome_kind IN ('exact_restatement','proposed_equivalence') AND ",
    retainedRevision('NEW.target_kind', 'NEW.target_id', 'NEW.target_revision_id'),
    'An interpretation names an exact retained target revision'
  ),
  requires(
    'knowledge_equivalence_disposition_requires_proposal',
    'knowledge_equivalence_dispositions',
    '',
    `
  SELECT 1 FROM knowledge_interpretations WHERE interpretation_id=NEW.interpretation_id AND outcome_kind='proposed_equivalence'`,
    'An equivalence rejection names a retained proposed equivalence'
  ),
  requires(
    'requirement_requires_interpretation',
    'requirements',
    "NEW.origin_kind='interpreted_source' AND ",
    `
  SELECT 1 FROM knowledge_interpretations
  WHERE interpretation_id=NEW.interpretation_id
    AND proposed_record_kind='requirement'
    AND outcome_kind='candidate_revision'
    AND target_kind='requirement'
    AND target_id=NEW.requirement_id
    AND target_revision_id=NEW.first_revision_id`,
    'An interpreted requirement requires its exact retained interpretation outcome'
  ),
  requires(
    'requirement_requires_origin_expectation',
    'requirements',
    "NEW.derived_from_kind='expectation' AND ",
    expectation('expectation'),
    'A derived requirement requires the exact expectation revision it derives from'
  ),
  requires(
    'task_use_requires_plan_event',
    'task_uses',
    '',
    `
  SELECT 1 FROM artifact_events WHERE artifact_id=NEW.artifact_id AND event_id=NEW.plan_event_id AND event_type IN ('plan_captured','plan_revised')`,
    'A task use is keyed to a plan event'
  ),
  requires(
    'task_use_requires_target',
    'task_uses',
    '',
    expectation('target'),
    'A task use requires its exact requirement or decision revision'
  ),
  requires(
    'recorded_choice_requires_target',
    'recorded_choices',
    '',
    record('target'),
    'A recorded choice requires its exact target revision'
  ),
  requires(
    'selector_resolution_requires_revision',
    'selector_resolutions',
    '',
    record('resolved'),
    'A selector resolves to an exact retained revision'
  ),
  requires(
    'knowledge_exception_requires_expectation',
    'knowledge_exceptions',
    '',
    expectation('expectation'),
    'An exception requires its exact expectation revision'
  ),
  requires(
    'conflict_answer_requires_rule',
    'conflict_answers',
    '',
    expectation('rule'),
    'A conflict answer requires the exact rule it was asked about'
  ),
  requires(
    'knowledge_revocation_requires_target',
    'knowledge_revocations',
    '',
    `
  SELECT 1 FROM knowledge_authorizations WHERE NEW.revoked_kind='authorization' AND authorization_id=NEW.revoked_id
  UNION ALL
  SELECT 1 FROM knowledge_exceptions WHERE NEW.revoked_kind='exception' AND exception_id=NEW.revoked_id
  UNION ALL
  SELECT 1 FROM conflict_answers WHERE NEW.revoked_kind='conflict_answer' AND answer_id=NEW.revoked_id
  UNION ALL
  SELECT 1 FROM assignments WHERE NEW.revoked_kind='assignment' AND assignment_id=NEW.revoked_id`,
    'A revocation requires the authorization, exception, conflict answer or assignment it ends'
  ),
  requires(
    'assignment_member_requires_identity',
    'assignment_members',
    '',
    `
  SELECT 1 FROM requirements WHERE NEW.member_kind='requirement' AND requirement_id=NEW.member_id
  UNION ALL
  SELECT 1 FROM decisions WHERE NEW.member_kind='decision' AND decision_id=NEW.member_id
  UNION ALL
  SELECT 1 FROM claims WHERE NEW.member_kind='claim' AND claim_id=NEW.member_id
  UNION ALL
  SELECT 1 FROM record_relationships WHERE NEW.member_kind='relationship' AND relationship_id=NEW.member_id`,
    'An assignment names identities this history holds'
  ),
  requires(
    'correction_action_requires_adopted',
    'correction_actions',
    'NEW.adopted_kind IS NOT NULL AND ',
    record('adopted'),
    'A correction requires the exact revision it makes stand'
  ),
  requires(
    'correction_target_requires_revision',
    'correction_targets',
    '',
    record('target'),
    'A correction requires every exact revision it names'
  ),
  requires(
    'passage_restatement_requires_revision',
    'passage_restatements',
    '',
    retainedRevision('NEW.restates_kind', 'NEW.restates_id', 'NEW.restates_revision_id'),
    'A restatement requires the exact revision it restates'
  ),
  requires(
    'processing_job_requires_source',
    'processing_jobs',
    '',
    `
  SELECT 1 FROM artifact_events WHERE NEW.source_kind='capture_event' AND event_id=NEW.source_id
  UNION ALL
  SELECT 1 FROM knowledge_sources WHERE NEW.source_kind='knowledge_source' AND source_id=NEW.source_id`,
    'A processing job requires its retained source'
  ),
].join('');

const retained = [
  [
    'knowledge_sources',
    "source_id=NEW.source_id OR (source_kind='capture_field' AND NEW.source_kind='capture_field' AND event_id=NEW.event_id AND field_path=NEW.field_path AND position=NEW.position)",
  ],
  ['knowledge_interpretations', 'interpretation_id=NEW.interpretation_id'],
  [
    'knowledge_interpretation_evidence',
    'interpretation_id=NEW.interpretation_id AND (position=NEW.position OR (source_id=NEW.source_id AND segment_id=NEW.segment_id AND prepared_start_utf8=NEW.prepared_start_utf8 AND prepared_end_utf8=NEW.prepared_end_utf8 AND passage_sha256=NEW.passage_sha256))',
  ],
  [
    'knowledge_equivalence_dispositions',
    'disposition_id=NEW.disposition_id OR interpretation_id=NEW.interpretation_id',
  ],
  ['subjects', 'subject_id=NEW.subject_id'],
  ['subject_revisions', 'revision_id=NEW.revision_id'],
  [
    'requirements',
    "requirement_id=NEW.requirement_id OR (origin_kind='promoted_source' AND NEW.origin_kind='promoted_source' AND passage_source_id=NEW.passage_source_id AND passage_location=NEW.passage_location AND passage_sha256=NEW.passage_sha256) OR (origin_kind='interpreted_source' AND NEW.origin_kind='interpreted_source' AND interpretation_id=NEW.interpretation_id)",
  ],
  ['requirement_revisions', 'revision_id=NEW.revision_id'],
  [
    'task_uses',
    'plan_event_id=NEW.plan_event_id AND target_kind=NEW.target_kind AND target_revision_id=NEW.target_revision_id AND role=NEW.role AND step_id IS NEW.step_id AND criterion_id IS NEW.criterion_id AND exception_id IS NEW.exception_id',
  ],
  ['recorded_choices', 'selection_id=NEW.selection_id'],
  ['approval_bindings', 'binding_id=NEW.binding_id'],
  [
    'approval_binding_targets',
    'binding_id=NEW.binding_id AND (position=NEW.position OR (scope_kind=NEW.scope_kind AND scope_value IS NEW.scope_value AND bound_kind=NEW.bound_kind AND target_kind IS NEW.target_kind AND target_revision_id IS NEW.target_revision_id AND selector_source_id IS NEW.selector_source_id AND selector_location IS NEW.selector_location AND selector_passage_sha256 IS NEW.selector_passage_sha256))',
  ],
  ['approval_binding_departures', 'binding_id=NEW.binding_id AND position=NEW.position'],
  [
    'selector_resolutions',
    'binding_id=NEW.binding_id AND selector_source_id=NEW.selector_source_id AND selector_location=NEW.selector_location AND selector_passage_sha256=NEW.selector_passage_sha256 AND resolved_kind=NEW.resolved_kind AND resolved_revision_id=NEW.resolved_revision_id AND scope_kind=NEW.scope_kind AND scope_value IS NEW.scope_value',
  ],
  ['knowledge_exceptions', 'exception_id=NEW.exception_id'],
  ['knowledge_authorizations', 'authorization_id=NEW.authorization_id'],
  ['conflict_answers', 'answer_id=NEW.answer_id'],
  ['assignments', 'assignment_id=NEW.assignment_id'],
  [
    'assignment_members',
    'assignment_id=NEW.assignment_id AND member_kind=NEW.member_kind AND member_id=NEW.member_id',
  ],
  ['knowledge_revocations', 'revocation_id=NEW.revocation_id'],
  ['correction_actions', 'action_id=NEW.action_id'],
  ['correction_targets', 'action_id=NEW.action_id AND position=NEW.position'],
  [
    'passage_restatements',
    'restatement_id=NEW.restatement_id OR (passage_source_id=NEW.passage_source_id AND passage_location=NEW.passage_location AND passage_sha256=NEW.passage_sha256 AND restates_kind=NEW.restates_kind AND restates_revision_id=NEW.restates_revision_id)',
  ],
  ['claim_revision_observations', 'revision_id=NEW.revision_id AND position=NEW.position'],
] as const;

const changed = (columns: readonly string[]) =>
  columns.map((column) => `NEW.${column} IS NOT OLD.${column}`).join(' OR ');

// A scheduling table is updated in place, so each one guards what an update could silently
// break: the facts settled at insert, and a row that has already ended. The replace guard also
// refuses an upsert, because a BEFORE INSERT trigger fires ahead of conflict handling.
const schedulingGuards = (
  [
    [
      'processing_jobs',
      'job_id=NEW.job_id OR (source_kind=NEW.source_kind AND source_id=NEW.source_id AND processor_contract=NEW.processor_contract)',
      [
        'job_id',
        'source_kind',
        'source_id',
        'processor_contract',
        'admitting_operation_id',
        'admission_json',
        'without_model',
        'admitted_at',
      ],
      "OLD.state='completed'",
      'A completed processing job is never run again',
    ],
    [
      'processing_attempts',
      'attempt_id=NEW.attempt_id OR (job_id=NEW.job_id AND attempt_number=NEW.attempt_number)',
      [
        'attempt_id',
        'job_id',
        'attempt_number',
        'owner_generation',
        'configuration_sha256',
        'configuration_json',
        'grant_id',
        'started_at',
      ],
      'OLD.outcome IS NOT NULL',
      'A settled processing attempt is retained as it ended',
    ],
    [
      'processing_usage',
      'usage_id=NEW.usage_id',
      ['usage_id', 'attempt_id', 'reserved_at', 'reserved_cost_usd'],
      "OLD.state<>'reserved'",
      'A settled reservation is retained as it ended',
    ],
  ] as const
)
  .map(
    ([table, collision, facts, settled, message]) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${collision}) BEGIN
  SELECT RAISE(ABORT, 'Processing records cannot be replaced');
END;
CREATE TRIGGER ${table}_fixed_facts BEFORE UPDATE ON ${table} WHEN ${changed(facts)} BEGIN
  SELECT RAISE(ABORT, 'Processing facts fixed at insert are immutable');
END;
CREATE TRIGGER ${table}_settled BEFORE UPDATE ON ${table} WHEN ${settled} BEGIN
  SELECT RAISE(ABORT, '${message}');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Processing records are retained');
END;`
  )
  .join('');

const singletonGuards = ['processing_lease', 'processing_control']
  .map(
    (table) => `
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table}) BEGIN
  SELECT RAISE(ABORT, 'Processing records cannot be replaced');
END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'Processing records are retained');
END;`
  )
  .join('');

// A paid call is never repeated by accident: a finished job takes no further attempt, and an
// attempt whose outcome is still open is settled, as unknown when its result was lost, before the
// job is attempted again.
const attemptAdmission = `
CREATE TRIGGER processing_attempt_requires_open_job BEFORE INSERT ON processing_attempts
WHEN EXISTS (SELECT 1 FROM processing_jobs WHERE job_id=NEW.job_id AND state IN ('completed','terminal_failure')) BEGIN
  SELECT RAISE(ABORT, 'A finished processing job takes no further attempt');
END;
CREATE TRIGGER processing_attempt_requires_settled_attempts BEFORE INSERT ON processing_attempts
WHEN EXISTS (SELECT 1 FROM processing_attempts WHERE job_id=NEW.job_id AND outcome IS NULL) BEGIN
  SELECT RAISE(ABORT, 'An unsettled attempt is settled before its job is attempted again');
END;
`;

// The attempt row exists before its paid call is spawned, so no call is ever unrecorded, and the
// provider's process is only known afterwards: the record is set once on an attempt still open,
// never fixed at insert and never changed, so a recovering owner reads exactly what was spawned.
const processRecordOnce = `
CREATE TRIGGER processing_attempt_process_once BEFORE UPDATE ON processing_attempts
WHEN OLD.process_json IS NOT NULL AND NEW.process_json IS NOT OLD.process_json BEGIN
  SELECT RAISE(ABORT, 'A processing attempt records its provider process once');
END;
`;

// The compatibility marker retains the first confirmation and is never rewritten by later ones.
const modelResumeOnce = `
CREATE TRIGGER processing_job_model_resume_once BEFORE UPDATE ON processing_jobs
WHEN OLD.model_resumed_at IS NOT NULL AND (${['model_resumed_at', 'model_resumed_by', 'model_resumed_by_basis', 'model_resume_grant_id'].map((column) => `NEW.${column} IS NOT OLD.${column}`).join(' OR ')}) BEGIN
  SELECT RAISE(ABORT, 'A consented model resume is recorded once');
END;
`;

const modelConfirmationGuards = `
CREATE TRIGGER processing_model_confirmations_no_replace BEFORE INSERT ON processing_model_confirmations
WHEN EXISTS (
  SELECT 1 FROM processing_model_confirmations
  WHERE confirmation_id=NEW.confirmation_id
    OR (job_id=NEW.job_id AND confirmation_sequence=NEW.confirmation_sequence)
) BEGIN
  SELECT RAISE(ABORT, 'Processing model confirmations cannot be replaced');
END;
CREATE TRIGGER processing_model_confirmations_no_update BEFORE UPDATE ON processing_model_confirmations BEGIN
  SELECT RAISE(ABORT, 'Processing model confirmations are append-only');
END;
CREATE TRIGGER processing_model_confirmations_no_delete BEFORE DELETE ON processing_model_confirmations BEGIN
  SELECT RAISE(ABORT, 'Processing records are retained');
END;
`;

const reopeningGuards = `
CREATE TRIGGER processing_job_reopenings_no_replace BEFORE INSERT ON processing_job_reopenings
WHEN EXISTS (
  SELECT 1 FROM processing_job_reopenings
  WHERE reopening_id=NEW.reopening_id
    OR (job_id=NEW.job_id AND reopening_sequence=NEW.reopening_sequence)
) BEGIN
  SELECT RAISE(ABORT, 'Processing job reopenings cannot be replaced');
END;
CREATE TRIGGER processing_job_reopenings_no_update BEFORE UPDATE ON processing_job_reopenings BEGIN
  SELECT RAISE(ABORT, 'Processing job reopenings are append-only');
END;
CREATE TRIGGER processing_job_reopenings_no_delete BEFORE DELETE ON processing_job_reopenings BEGIN
  SELECT RAISE(ABORT, 'Processing records are retained');
END;
CREATE TRIGGER processing_job_reopening_requires_gave_up BEFORE INSERT ON processing_job_reopenings
WHEN NOT EXISTS (SELECT 1 FROM processing_jobs WHERE job_id=NEW.job_id AND state='terminal_failure') BEGIN
  SELECT RAISE(ABORT, 'Only a processing job that gave up is reopened');
END;
CREATE TRIGGER processing_job_reopening_follows_every_attempt BEFORE INSERT ON processing_job_reopenings
WHEN NEW.attempts_before IS NOT (SELECT coalesce(max(attempt_number),0) FROM processing_attempts WHERE job_id=NEW.job_id) BEGIN
  SELECT RAISE(ABORT, 'A reopening starts after every attempt the job has made');
END;
CREATE TRIGGER processing_job_reopening_next_sequence BEFORE INSERT ON processing_job_reopenings
WHEN NEW.reopening_sequence IS NOT (SELECT coalesce(max(reopening_sequence),0)+1 FROM processing_job_reopenings WHERE job_id=NEW.job_id) BEGIN
  SELECT RAISE(ABORT, 'A reopening takes the sequence after the job''s last one');
END;
`;

// The generation is what fences a superseded worker at settlement, so it only moves forward, a
// new owner always takes a new one, and the row that carries it is never removed.
const leaseGeneration = `
CREATE TRIGGER processing_lease_generation BEFORE UPDATE ON processing_lease
WHEN NEW.owner_generation < OLD.owner_generation OR (NEW.owner_id IS NOT NULL AND NEW.owner_id IS NOT OLD.owner_id AND NEW.owner_generation <= OLD.owner_generation) BEGIN
  SELECT RAISE(ABORT, 'A new lease owner takes a later generation');
END;
`;

export const PROJECT_KNOWLEDGE_SCHEMA =
  tables +
  scheduling +
  ['requirement', 'subject'].map(firstRevisionGuard).join('') +
  references +
  insertOnlyGuards(retained, 'Knowledge records') +
  schedulingGuards +
  attemptAdmission +
  processRecordOnce +
  modelResumeOnce +
  modelConfirmationGuards +
  reopeningGuards +
  singletonGuards +
  leaseGeneration;
