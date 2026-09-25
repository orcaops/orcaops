# Project database

SQLite is authoritative for mutable structured project history. Each project has
one WAL database. `connection.ts` validates identity and schema before admitting
access; `transactions.ts` owns serialized writes, operation retries and receipts.
Domain modules own their records and expose bounded read and write operations.
Read transactions stay short, and preparation happens before write transactions.

`schema.ts` assembles the domain schema fragments into one initial schema and sets
its version once. Fragments group tables by ownership; they are not a migration
sequence. Authoritative and derived column ownership is documented beside each
fragment.

Schema 29 is the first supported canonical format. Versions 1–28 existed only
during development and were never distributed. They are deliberately unsupported;
ordinary reads, writes and initialization cannot upgrade or replace them. Keeping
29 avoids accidentally admitting an old development database as the initial format.
The legacy file-history converter creates this complete schema directly.

Schema 30 adds the continuing-knowledge family in `knowledge-schema.ts` and rebuilds
`record_relationships`, `adoptions`, `claim_revisions` and `decision_revisions` with
wider constraints. Every other object keeps its schema-29 definition exactly, so a
released store differs from a current one only there. Reads, writes and initialization refuse a schema-29 store as they
refuse any other version: nothing opens, upgrades or replaces it implicitly.

[Fixture documentation](fixtures/README.md) describes the shared schema snapshot
and focused row datasets. Schema 29 shipped in the published 0.2.0 and 0.2.1
packages, and the fixtures frozen from them are the baseline for supported upgrades.

Project display names are retained by the `project.display_name` operation result.
The first result owns the label; setup retries keep it rather than renaming history
when a remote or directory changes. This small create-once fact uses the existing
operation records without a second settings table. Watch reads it passively, falling
back to the retained repository directory for projects created before names were
saved. UI selection always uses the project ID, including when labels are identical.
