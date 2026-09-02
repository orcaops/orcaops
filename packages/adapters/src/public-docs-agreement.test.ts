import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CONFIG_SCHEMA_VERSION, resolveConfig } from '@orcaops/storage';

import { SKILL_IDS } from './types.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const docsRoot = path.join(repoRoot, 'apps/docs/content');

async function doc(relativePath: string): Promise<string> {
  return readFile(path.join(docsRoot, relativePath), 'utf8');
}

function referencedSkills(markdown: string): string[] {
  const pattern = /(^|[^/.\w-])\/?orcaops-([a-z][a-z0-9-]*)(?![a-z0-9-])/gm;
  const nonSkillIdentifiers = new Set(['verdict']);
  return [...markdown.matchAll(pattern)]
    .map((match) => match[2]!)
    .filter((id) => !nonSkillIdentifiers.has(id));
}

describe('published documentation agreement', () => {
  it('references only skills in the canonical shipped registry', async () => {
    const markdownFiles = (await readdir(docsRoot)).filter((name) => name.endsWith('.md')).sort();
    const referenced = new Set<string>();

    for (const name of markdownFiles) {
      for (const id of referencedSkills(await doc(name))) referenced.add(id);
    }

    const canonical = new Set<string>(SKILL_IDS);
    const unknown = [...referenced].filter((id) => !canonical.has(id)).sort();
    expect(unknown).toEqual([]);
    // Canary: without it, `unknown === []` passes vacuously on a broken regex.
    expect(referenced).toContain('capture');
  });

  it('confines the cloud skills to the teams-facing pages', async () => {
    const TEAMS_PAGES = new Set(['plan-review.md', 'authentication.md']);
    const generalPages = (await readdir(docsRoot))
      .filter((name) => name.endsWith('.md') && !TEAMS_PAGES.has(name))
      .sort();
    expect(generalPages.length).toBeGreaterThan(3);

    const CLOUD_SKILLS = ['plan-approval', 'review'];
    for (const name of generalPages) {
      const markdown = await doc(name);
      for (const id of CLOUD_SKILLS) {
        expect(markdown, `${name} references the cloud skill "${id}"`).not.toContain(
          `/orcaops-${id}\``
        );
      }
    }
  });

  it('keeps the configuration example on the current schema and runtime attribution model', async () => {
    const [configuration, gettingStarted, workingWithYourAgent] = await Promise.all([
      doc('configuration.md'),
      doc('getting-started.md'),
      doc('working-with-your-agent.md'),
    ]);
    const exampleBlock = configuration.match(/```json\n([\s\S]*?)\n```/);
    expect(exampleBlock, 'configuration.md must contain a JSON example').not.toBeNull();

    const example = JSON.parse(exampleBlock![1]) as Record<string, unknown>;
    expect(example.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(example).not.toHaveProperty('agent');
    expect(resolveConfig(example).schema_version).toBe(CONFIG_SCHEMA_VERSION);
    const attributionDocs = `${configuration}\n${gettingStarted}\n${workingWithYourAgent}`;
    expect(attributionDocs).not.toContain('config.agent');
    expect(attributionDocs).not.toContain('sets the single capture identity');
    expect(attributionDocs).not.toContain('"agent":');
  });
});
