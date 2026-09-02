import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The semantic curation language lives ONLY in the task-review SKILL
 * (packages/adapters); there is no `taskReviewPrompt.ts` module and no
 * `STORY_CURATION_SYSTEM_PROMPT` in the engine. The architecture
 * rule is that ALL model instructions live in the skill and the engine is
 * model-free, so none of the distinctive curator-prompt prose may appear in
 * any engine source. This is a grep-style assertion over the whole src tree.
 */
describe('retired curation prompt', () => {
  const srcDir = __dirname;
  const thisFile = path.basename(__filename);

  // Distinctive verbatim phrases that were MOVED into the skill. If any of
  // these reappears under review-engine/src the curation language has leaked
  // back into the model-free engine.
  const bannedPhrases = [
    'You are the capture-grounded Task Review curator',
    'Produce exactly one cohesive Story from the engine-proposed intent beats',
    'Always emit at least one structural Part',
    'STORY_CURATION_SYSTEM_PROMPT',
    'taskReviewPrompt',
  ];

  const tsFiles = readdirSync(srcDir).filter((f) => f.endsWith('.ts') && f !== thisFile);

  it('leaves no curation-prompt module in the engine source tree', () => {
    expect(tsFiles).not.toContain('taskReviewPrompt.ts');
    expect(tsFiles).not.toContain('taskReviewPrompt.test.ts');
  });

  it('leaves no curation-prompt prose anywhere under review-engine/src', () => {
    for (const file of tsFiles) {
      const source = readFileSync(path.join(srcDir, file), 'utf8');
      for (const phrase of bannedPhrases)
        expect(source.includes(phrase), `${file} contains retired curation text "${phrase}"`).toBe(
          false
        );
    }
  });
});
