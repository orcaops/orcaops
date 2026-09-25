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
| `released/`              | Databases the published 0.2.0 and 0.2.1 packages wrote: the supported upgrade baseline    |
| `synthetic-schema-29/`   | Synthetic exact-revision and source-plan rows layered over the released 0.2.1 database    |

Scenario inputs are not necessarily standalone database images. Tests may select
only the rows relevant to an operation. Paths inside retained authored bytes are
synthetic producer locations; changing those bytes also changes their content
hashes. Restoration replaces the store root and writes evidence into a disposable
directory.

No canonical SQLite build was distributed before schema 29. The old development
migration snapshots are intentionally removed. Schema 29 is the initial supported
format; numbers 1–28 remain reserved so an old developer database cannot be mistaken
for a current one. Those databases fail closed and are never reset automatically.
The separately frozen `0.2.0-rc.2` legacy converter fixture remains supported.

`current.json` follows the schema this checkout builds, now version 33, and the
scenario files that name a version follow it. Its populated relationship, adoption and
claim and decision revision rows carry what a schema-29 row means under the wider
tables: established or adopted, attributed to the name they had on an unknown basis,
with no authorization, and with no standing, subject or derivation, none of which a
released row records. `released/` and
`synthetic-schema-29/` stay at schema 29 and restore under their own definitions.

## Released baseline

Schema 29 shipped in the published `@orcaops/cli` 0.2.0 and 0.2.1 packages, so a later
schema must prove populated upgrade preservation against what those packages wrote.
`released/` holds one database per release, written by the package installed from the
public registry and driven offline through captures, a seed import with enrichment, a
complete Task Review, refused and blocked captures and a second worktree. Each
`cli-<version>/` has:

- `database.json`: every row with BLOBs as exact hex, and the review evidence files the
  rows name;
- `manifest.json`: producer identity, generation command, schema and per-table content
  digests, the original pragmas, a reason for every empty table, and the cells that hold
  machine-specific values;
- `history.sqlite3.br.base64` and `history.sqlite3-wal.br.base64`: the original main file
  and write-ahead log, brotli-compressed, for tests that need the bytes and not the rows;
- `retained-refs.bundle.base64`: a Git bundle of the refs the rows name.

`cli-0.2.1-converted-from-0.2.0-rc.2/` is the database 0.2.1 wrote by converting a
legacy history that the published 0.2.0-rc.2 wrote. Only conversion fills the legacy
tables and the plan idempotency records. `schema.json` holds the definitions once: all
three databases hold the same 530 objects. An identical definition does not establish
identical producer behavior, so each release keeps its own rows.

The rows were read through the write-ahead log. A release leaves the log beside the main
file and never restarts it: captures append frames, a checkpoint copies only some of them
into the main file, and a review write truncates the log. In the frozen 0.2.1 run the
log held 134 frames and 22 of 901 rows existed only there, while the main file alone
passed its integrity check. Each manifest records these counts. A copy of the main file
alone is a valid database and not a copy of the project's history.

The freeze script checks two of the empty-table reasons against the released bundle:
that the bundle holds no INSERT statement for the table, and, for
`execution_checkpoint_recoveries` and `seed_bundle_authoring`, that the strings a
producer of their rows would need are missing. The cloud, racing-writer and legacy
reasons are assigned by table name. For those the script checks only that the bundle can
insert into the table; the reason itself records what reading and running the release
established, including that its cloud verbs refuse without credentials and write
nothing. Every other empty table of the converted database takes
`outside_this_conversion` unchecked, and the fixture tests confirm the 0.2.1 fixture
holds rows in each. A manifest frozen from now on names the check behind each reason as
its `basis`.

Never regenerate a released baseline with newer code; use it to verify upgrades. The
freeze script refuses a release whose directory exists, the tests pin each content
digest beside its manifest, and a manifest must name published packages as its
producers. The script once took a `--replace-frozen-release` flag, used a single time:
the first freeze exercised too little of the released tool (48 of 126 tables, and no
review, enrichment, refusal or conversion), so both releases were generated again by the
same published packages and frozen a second time (84 tables, plus 31 in the converted
database) before any schema change relied on them. The flag has since been removed, and
a frozen release can no longer be replaced.

Each frozen manifest records the Node version a run executed under (v22.14.0, darwin
arm64) and not the binary. The copy of Node each run executed hashed to:

- `cli-0.2.0`: sha256 `e2d4915d03eda6a2f00a09920e7eeb7a04ad123f9aaad61b1481179fe1bf50e0`
- `cli-0.2.1`: sha256 `e2d4915d03eda6a2f00a09920e7eeb7a04ad123f9aaad61b1481179fe1bf50e0`
- `cli-0.2.1-converted-from-0.2.0-rc.2`: sha256
  `e2d4915d03eda6a2f00a09920e7eeb7a04ad123f9aaad61b1481179fe1bf50e0`

A later run records the hash in its summary as `producer.runtime.node_sha256`. The
generation scripts changed to record it, so a frozen manifest's `procedure_sha256` names
the scripts as committed with that freeze and not the files beside it now.

To reproduce a run without touching a frozen release, generate into an empty directory
outside any repository and compare the printed summary with the manifest:

```bash
node packages/storage/tests/released-producer-database.generate.mjs 0.2.1 <empty-dir>
node packages/storage/tests/released-legacy-conversion.generate.mjs 0.2.0-rc.2 0.2.1 <empty-dir>
```

A new release is frozen from such a run with
`released-producer-fixture.freeze.mjs <summary.json> <run-dir>`.

No released build can write claim, decision, relationship, adoption, assessment or
criterion lineage rows, and source-plan rows need the cloud service.
`synthetic-schema-29/` covers those tables: rows published through the real storage
writers over the released 0.2.1 database, at a commit whose database code is
byte-identical to that release. Its manifest says first that it is synthetic. It lets an
upgrade test establish that populated rows of those tables survive. It is not released
history and says nothing about what a released producer writes.

These files are test-only and are excluded from the published storage package.
