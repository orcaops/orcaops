# Database test data

These synthetic records exercise retained history without using customer databases.
`current.json` owns the single complete schema snapshot and a populated database:
artifacts, operation receipts, reviews, comments, decisions, claims, relationships
and adoptions. The other files contain only scenario rows and, where needed,
requests or immutable evidence. Shared restoration uses the definitions in
`current.json` and checks the resulting schema and foreign keys.

| File                     | Purpose                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `current.json`           | Exact schema comparison, populated reopen, receipt replay and unsupported-version refusal |
| `semantic-review.json`   | Review submission, anchors and semantic command behavior                                  |
| `pending-review.json`    | Pending review recovery and query metadata rebuilds                                       |
| `artifact-records.json`  | Exact-revision writers starting without existing claims or decisions                      |
| `artifact-events.json`   | Retained event decoding and reader behavior                                               |
| `artifact-history.json`  | Artifact insertion and historical content                                                 |
| `execution-history.json` | Execution and capture lifecycle inputs                                                    |
| `retention-inputs.json`  | Git retention, usage and review finalization inputs                                       |
| `review-inputs.json`     | Review relational constraints                                                             |

Scenario inputs are not necessarily standalone database images. Tests may select
only the rows relevant to an operation. Paths inside retained authored bytes are
synthetic producer locations; changing those bytes also changes their content
hashes. Restoration replaces the store root and writes evidence into a disposable
directory.

No canonical SQLite build was distributed before this schema. The old development
migration snapshots are intentionally removed. Schema 29 is the initial supported
format; numbers 1–28 remain reserved so an old developer database cannot be mistaken
for a current one. Those databases fail closed and are never reset automatically.
The separately frozen `0.2.0-rc.2` legacy converter fixture remains supported.

This snapshot becomes a compatibility baseline only when SQLite ships. At that
release, freeze its exact schema, producer version and representative rows. Never
regenerate a released baseline with newer code; use it to verify future migrations.
These files are test-only and are excluded from the published storage package.
