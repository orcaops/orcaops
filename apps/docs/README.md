# @orcaops/docs

User-facing documentation for the `orcaops` CLI. Markdown under `content/` is
the source of truth, and VitePress produces the hosted, searchable site.

## Development

```bash
pnpm --filter @orcaops/docs dev       # live development server
pnpm --filter @orcaops/docs build     # static site → dist/site/
pnpm --filter @orcaops/docs preview   # preview the built site
```

The production build also generates `llms.txt`, `llms-full.txt`, and a
Markdown version of each page. It validates cross-page fragment links against
the actual rendered VitePress headings before succeeding.

Config lives in `content/.vitepress/config.mjs`. Sidebar sections, guide order,
and titles come from `docs.config.mjs`; local full-text search and clean URLs
are enabled. The homepage is `content/index.md`.

The root `pnpm build` includes this site through Turbo and caches `dist/`.

### GitHub Pages

The site publishes to <https://orcaops.github.io/orcaops/> from
`.github/workflows/docs-pages.yml` whenever `main` changes. The workflow can
also be run manually from the Actions tab.

The VitePress `base` is `/orcaops/`, matching the GitHub Project Pages path.
In the repository settings, select **Pages → Build and deployment → Source →
GitHub Actions** before the first deployment.

## Authoring

- Keep one `.md` file per guide in `content/`, named for its clean public slug
  such as `getting-started.md`.
- Add every guide to the appropriate section in `docs.config.mjs`.
- Give every page a unique frontmatter `description`. VitePress uses it for the
  page meta description, and the LLM index uses the same summary.
- Write cross-page links as `./<slug>.md`, optionally followed by a heading
  fragment such as `./configuration.md#shape`. VitePress resolves the page and
  the production build validates the rendered fragment.
- Use native VitePress containers such as `::: tip` and `::: warning` when a
  note has a real semantic type. Ordinary explanatory prose should remain
  ordinary prose.

## Scope

This package is product documentation. Promotional and landing-page content is
intentionally not kept here.
