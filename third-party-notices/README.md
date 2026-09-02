# Supplemental third-party notices

Notices for bundled packages that declare a licence requiring its notice in all
copies but ship no licence file of their own.

The notice cannot be dropped beside the package: everything installed lives
under `node_modules/.pnpm`, which is not tracked, so the next install would
erase it. Keeping these in the repository is what makes them survive.

## Layout

One directory per package, named `<name>@<version>` with the `/` of a scoped
name replaced by `+` (`@tokenizer/token` at 0.3.0 is `@tokenizer+token@0.3.0`).
Each holds:

- `LICENSE` — the notice text, verbatim as fetched.
- `SOURCE.txt` — the exact URL fetched, the commit or tag, the date, and how the
  notice was verified to govern that package.

`renderNotice` in `scripts/third-party-notices.mjs` consults this directory when,
and only when, a package ships no licence file of its own. A `LICENSE` here with
no readable, non-empty `SOURCE.txt` beside it FAILS the release build rather
than being skipped: a missing notice stops the build loudly, while a licence
file with no recorded provenance asserts an attribution nobody can check.

Directories are keyed by version. A version bump needs its notice re-fetched and
re-verified; it does not inherit the previous version's.

## Adding one

Fetch only from the repository that package's own `package.json` declares — not
from a search result, not from a mirror, not from memory. For a monorepo, find
the licence that actually governs that package's directory and say in
`SOURCE.txt` which path it came from. Never fill a template with an inferred
copyright holder, and never copy a notice from another package. A package whose
notice cannot be sourced stays unresolved.
