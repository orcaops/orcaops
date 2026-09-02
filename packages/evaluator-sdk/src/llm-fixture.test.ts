import { describe, expect, it } from 'vitest';

import { runLlmFixture } from './llm-fixture.js';
import { makeContext, makePlanStep } from './make-context.js';

const PROMPT_BODY = 'Grade the delivery against the rubric.';

function run(overrides: Partial<Parameters<typeof runLlmFixture>[0]> = {}) {
  return runLlmFixture({
    context: makeContext(),
    promptBody: PROMPT_BODY,
    additionalContextSections: [],
    response: '```orcaops-verdict\nPASS\n```',
    ...overrides,
  });
}

describe('runLlmFixture', () => {
  it('assembles the prompt the runner would send', () => {
    const { prompt } = run();
    expect(prompt).toContain('## Context');
    expect(prompt).toContain('Plan task: test');
    expect(prompt).toContain(`## Task\n\n${PROMPT_BODY}`);
  });

  it('returns the context block on its own', () => {
    const { contextBlock, prompt } = run();
    expect(contextBlock.startsWith('## Context')).toBe(true);
    expect(contextBlock).not.toContain(PROMPT_BODY);
    expect(prompt.startsWith(contextBlock)).toBe(true);
  });

  it('includes a declared section and omits an undeclared one', () => {
    const context = makeContext({
      plan: {
        ...makeContext().plan,
        plan_steps: [
          {
            ...makePlanStep(1, 'ship the suite'),
            acceptance_criteria: [{ criterion_id: 'crit-1', text: 'at least 42 tests' }],
          },
        ],
      },
    });
    const withRubric = run({ context, additionalContextSections: ['acceptance-criteria'] });
    expect(withRubric.contextBlock).toContain('[crit-1] at least 42 tests');
    expect(withRubric.contextBlock).not.toContain('## Diff boundary');

    const withoutRubric = run({ context, additionalContextSections: [] });
    expect(withoutRubric.contextBlock).not.toContain('[crit-1] at least 42 tests');
  });

  it('does not slice the context block out of the prompt', () => {
    // A pinned source plan may itself contain a `## Task` heading. Splitting
    // the assembled prompt on that separator would truncate the block a test
    // is asserting against.
    const context = makeContext({
      source_plan: {
        source_ref: { kind: 'local', locator: 'docs/plan.md' },
        content: 'intro\n\n## Task\n\nthe real obligations live here',
        hash: 'a'.repeat(64),
      },
    });
    const { contextBlock } = run({ context, additionalContextSections: ['source-plan'] });
    expect(contextBlock).toContain('the real obligations live here');
  });

  it('parses the verdict out of the supplied response', () => {
    expect(run({ response: '```orcaops-verdict\nVIOLATION\n```' }).verdict).toBe('violation');
    expect(run({ response: 'prose\n\nINFO\n' }).verdict).toBe('info');
  });

  it('reports a missing verdict as null instead of throwing', () => {
    // The runner turns this into NO_VERDICT_LINE rather than an exception, so
    // the harness must let a test assert on it the same way.
    expect(run({ response: 'I would rather not commit to a verdict.' }).verdict).toBeNull();
  });

  it('resolves an echoed example followed by the real verdict', () => {
    const response = [
      'The format asked for is:',
      '',
      '```orcaops-verdict',
      'PASS',
      '```',
      '',
      'Two criteria are under-delivered.',
      '',
      '```orcaops-verdict',
      'VIOLATION',
      '```',
    ].join('\n');
    expect(run({ response }).verdict).toBe('violation');
  });
});
