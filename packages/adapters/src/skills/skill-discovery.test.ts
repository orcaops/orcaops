import { describe, expect, it } from 'vitest';

import { SKILL_TEMPLATES } from './index.js';
import { COMMAND_TEMPLATES } from '../commands/index.js';

const words = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((word) => word.length > 2)
  );

const overlap = (description: string, utterance: string): number => {
  const descriptionWords = words(description);
  return [...words(utterance)].filter((word) => descriptionWords.has(word)).length;
};

const selectionPhraseCases = [
  ['resume', 'where was I?'],
  ['resume', 'continue artifact <id> here'],
  ['recap', 'what did I do yesterday?'],
  ['recap', 'draft the release notes'],
  ['search', 'have we worked on X before?'],
  ['timetravel', 'which checkpoint broke this test?'],
  ['adversarial-review', 'poke holes in this'],
  ['plan-approval', 'is my plan approved yet?'],
  ['plan-approval', 'read or download the plan body'],
  ['digest', 'draft the PR description'],
  ['doctor', 'is Orcaops set up correctly?'],
  ['doctor', 'command fails unexpectedly'],
  ['decisions', 'what did we decide about X?'],
  ['decisions', 'why did we choose Y over Z?'],
  ['decisions', 'turn these decisions into ADRs'],
  ['estimate', 'how big is this task?'],
  ['estimate', 'what did similar work cost?'],
  ['estimate', 'how did the estimate hold up?'],
  ['finish', 'finish this work'],
  ['finish', 'wrap this up'],
  ['finish', 'get this ready for a PR'],
  ['lessons', 'what should I do differently?'],
  ['lessons', 'what keeps going wrong?'],
  ['lessons', 'lessons learned from this work'],
  ['loose-ends', "what's still open?"],
  ['loose-ends', 'what did we defer?'],
  ['loose-ends', 'any loose ends?'],
  ['task-review', 'anchor the review reasoning to code'],
  ['seed-discovery', 'provenance lookup finds nothing'],
  ['seed-discovery', 'directory with no captured history'],
  ['seed-discovery', 'prior-art search is empty'],
] as const;

const nearNeighborCases = [
  ['task-review', 'review', 'generate an Orcaops review for this branch'],
  ['task-review', 'review', 'address the open Task Review comments on this branch'],
  ['review', 'task-review', 'address the review feedback on my PR'],
  ['review', 'task-review', 'check for new review comments on the PR'],
  ['review', 'task-review', 'wait for the reviewer to respond'],
  ['review', 'task-review', 'reply to the reviewer threads and push fixes'],
  ['plan-critique', 'search', 'critique this rate-limit plan using what we learned before'],
  ['plan-critique', 'search', 'review this plan against earlier auth decisions'],
  ['plan-critique', 'search', 'poke holes in this plan before I start'],
  ['search', 'plan-critique', 'have we worked on rate limits before?'],
  ['search', 'plan-critique', 'find earlier work about authentication'],
  ['search', 'plan-critique', 'what did we decide last time we touched caching?'],
  ['search', 'plan-critique', 'search old artifacts for Redis'],
] as const;

describe('skill discovery surface', () => {
  it('has a description for every Orcaops listing entry', () => {
    for (const entry of [...SKILL_TEMPLATES, ...COMMAND_TEMPLATES]) {
      expect(entry.description.trim(), entry.id).not.toBe('');
    }
  });

  it.each(selectionPhraseCases)('%s keeps the natural selection phrase “%s”', (id, phrase) => {
    const description = SKILL_TEMPLATES.find((skill) => skill.id === id)?.description;

    expect(description).toBeDefined();
    expect(description!.toLowerCase()).toContain(phrase.toLowerCase());
  });

  it('keeps sibling skill names out of frontmatter descriptions', () => {
    for (const source of SKILL_TEMPLATES) {
      for (const sibling of SKILL_TEMPLATES) {
        if (source.id === sibling.id) continue;
        expect(source.description, `${source.id} names ${sibling.id}`).not.toContain(
          `orcaops-${sibling.id}`
        );
        expect(source.description.toLowerCase(), `${source.id} names ${sibling.id}`).not.toContain(
          `${sibling.id} skill`
        );
      }
    }
  });

  it.each(nearNeighborCases)(
    '%s has more matching description words than %s for “%s”',
    (intended, alternative, utterance) => {
      const intendedDescription = SKILL_TEMPLATES.find(
        (skill) => skill.id === intended
      )?.description;
      const alternativeDescription = SKILL_TEMPLATES.find(
        (skill) => skill.id === alternative
      )?.description;

      expect(intendedDescription).toBeDefined();
      expect(alternativeDescription).toBeDefined();
      expect(overlap(intendedDescription!, utterance)).toBeGreaterThan(
        overlap(alternativeDescription!, utterance)
      );
    }
  );
});
