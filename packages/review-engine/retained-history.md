# Retained review resources

SQLite is authoritative for mutable review state, using the project's existing
database. Review identities, run inputs and submissions, comment revisions,
workflow transitions, exact revision targets, and current publication selections
are retained rows. Branch names locate reviews; they do not establish identity.
Legacy file-backed Task Reviews are excluded from conversion.

Floor and Story evidence remain immutable files. Publication records distinguish
the evidence kind and retain its identity and hash. Evidence must be durably
written before a row references it. Git retention refs are immutable and unique
per publication; changing a selection updates the database, never an existing ref.

Preparation runs outside transactions. Writers settle through the project
transaction runner and check the expected run and version. Stale synthesis cannot
become current or overwrite newer progress. Retrying an operation preserves its
identity and authored payload; a conflicting retry is refused.

Readers use short, consistent read transactions on an existing validated project
database. They never initialize history, migrate, repair application state, or
publish caches. SQLite-managed runtime coordination is permitted. Missing or
invalid retained evidence is reported as unavailable, not regenerated as an
apparently complete review.

The implementation lives in `src/database`: `floor-command.ts` prepares and
publishes floors, `run-command.ts` and `run-finalization.ts` manage runs and Story
publication, and the comment, workflow, and semantic modules preserve their
specific histories and targets. Watch uses these database readers. The retired
file publication, archive mirror, and native review-lock protocols are not part
of the runtime.
