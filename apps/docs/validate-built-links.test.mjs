import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateBuiltLinks } from './validate-built-links.mjs';

async function withSite(files, run) {
  const root = await mkdtemp(join(tmpdir(), 'orcaops-doc-links-'));
  try {
    for (const [path, html] of Object.entries(files)) await writeFile(join(root, path), html);
    await run({ outDir: root, site: { base: '/orcaops/' } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('accepts rendered same-page and cross-page fragments', async () => {
  await withSite(
    {
      'index.html': '<a href="/orcaops/guide#target">Guide</a>',
      'guide.html': '<h1 id="guide">Guide</h1><h2 id="target">Target</h2><a href="#guide">Top</a>',
    },
    validateBuiltLinks
  );
});

test('rejects a fragment absent from the rendered target', async () => {
  await withSite(
    {
      'index.html': '<a href="./guide#missing">Broken</a>',
      'guide.html': '<h1 id="present">Guide</h1>',
    },
    async (siteConfig) => {
      await assert.rejects(
        validateBuiltLinks(siteConfig),
        /index\.html: \.\/guide#missing targets missing fragment #missing/
      );
    }
  );
});
