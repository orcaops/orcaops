import { describe, expect, it } from 'vitest';

import { SKILL_TEMPLATES } from '../skills/index.js';
import type { SkillId, SkillTemplate } from '../types.js';
import {
  ALWAYS_DROPPED_HINT_KEY,
  type BootstrapContentInput,
  type HintRenderabilityInput,
  nonRenderingHintKeys,
  ORCAOPS_BLOCK_ROUTING_SENTINEL,
  renderableHintKeys,
  resolveBootstrapContent,
} from './bootstrap-content.js';
import { CURATED_HINTS } from './hints-catalog.js';

const BUILT_IN_READ_INTENTS: SkillId[] = ['resume', 'digest', 'why', 'search', 'doctor'];

const defaultOn = SKILL_TEMPLATES.filter(
  (s) => s.defaultEnabled !== false && (s.requires ?? []).length === 0
);

const resolve = (over: Partial<BootstrapContentInput> = {}) =>
  resolveBootstrapContent({
    prefix: 'orcaops',
    enabledSkills: SKILL_TEMPLATES,
    hints: undefined,
    commitInsideWindow: true,
    suppressedRouting: [],
    ...over,
  });

const triggerLineIds = (skills: ReadonlyArray<SkillTemplate<string>>): string[] =>
  skills.filter((s) => s.blockTriggerLine !== undefined).map((s) => s.id);

const checkpointStep = (content: ReturnType<typeof resolve>) => {
  const step = content.lifecycle.find((s) => s.phase === 'checkpoint');
  if (step === undefined) throw new Error('no checkpoint step');
  return step;
};

describe('routing', () => {
  it('carries every trigger-line skill plus the built-in read intents', () => {
    for (const skills of [SKILL_TEMPLATES, defaultOn]) {
      const content = resolveBootstrapContent({
        prefix: 'orcaops',
        enabledSkills: skills,
        hints: undefined,
        commitInsideWindow: true,
        suppressedRouting: [],
      });
      expect(content.routing).toHaveLength(
        triggerLineIds(skills).length + BUILT_IN_READ_INTENTS.length
      );
      expect(content.routing.map((e) => e.id)).toEqual([
        ...BUILT_IN_READ_INTENTS,
        ...triggerLineIds(skills),
      ]);
    }
  });

  it('drops only the suppressed ids', () => {
    const all = resolve().routing.map((e) => e.id);
    const suppressed: SkillId[] = ['why', 'plan-critique'];
    const kept = resolve({ suppressedRouting: suppressed }).routing.map((e) => e.id);
    expect(kept).toEqual(all.filter((id) => !suppressed.includes(id)));
    expect(all).toEqual(expect.arrayContaining(suppressed));
  });

  it('withholds the survey pointer when resume is suppressed', () => {
    expect(resolve().surveyTail).toContain('orcaops status --json');
    expect(resolve({ suppressedRouting: ['resume'] }).surveyTail).toBeNull();
  });

  it('leads with every quoted phrase, on one line', () => {
    for (const entry of resolve().routing) {
      const cues = entry.line.replace(/\s+/g, ' ').split('→')[0];
      const quoted = cues.match(/"[^"]+"/g) ?? [];
      expect(quoted.length, `"${entry.id}" offers no user phrasing`).toBeGreaterThanOrEqual(2);
      expect(entry.lead).toBe(quoted.join(', '));
      expect(entry.lead).not.toContain('\n');
    }
  });

  it('leaves quoted text after the arrow out of the lead', () => {
    const negated: SkillTemplate<string> = {
      ...SKILL_TEMPLATES[0],
      id: 'estimate',
      blockTriggerLine:
        '"size this change", "how big is this?" → `orcaops-estimate`, but not when the user says "never mind"',
    };
    const entry = resolve({ enabledSkills: [negated] }).routing.find((e) => e.id === 'estimate');
    expect(entry?.lead).toBe('"size this change", "how big is this?"');
  });

  it('splits on the arrow between phrases and action, not one inside a phrase', () => {
    const arrowed: SkillTemplate<string> = {
      ...SKILL_TEMPLATES[0],
      id: 'estimate',
      blockTriggerLine: '"plan → estimate", "size this change" → `orcaops-estimate`',
    };
    const entry = resolve({ enabledSkills: [arrowed] }).routing.find((e) => e.id === 'estimate');
    expect(entry?.lead).toBe('"plan → estimate", "size this change"');
    expect(entry?.action).toBe('orcaops-estimate');
  });

  it('names a skill that carries no quoted phrasing rather than dropping it', () => {
    const bare: SkillTemplate<string> = {
      ...SKILL_TEMPLATES[0],
      id: 'estimate',
      blockTriggerLine: 'sizing a change → `orcaops-estimate`',
    };
    const entry = resolve({ enabledSkills: [bare] }).routing.find((e) => e.id === 'estimate');
    expect(entry?.lead).toBe('sizing a change');
  });

  it('routes under the active naming prefix', () => {
    const content = resolve({ prefix: 'oo' });
    expect(content.routing.map((e) => e.ref)).toContain('oo-why');
    expect(content.routing.every((e) => e.line.includes(e.ref))).toBe(true);
  });

  it('carries the whole post-arrow instruction, not just the ref', () => {
    const byId = new Map(resolve({ prefix: 'oo' }).routing.map((e) => [e.id, e]));
    // Truncating at the ref would invert this one: it asks the agent NOT to
    // invoke the skill.
    expect(byId.get('author-evaluator')?.action).toBe(
      'recommend the human run /oo-author-evaluator rather than invoking it yourself'
    );
    expect(byId.get('plan-critique')?.action).toBe('oo-plan-critique, before work starts');
    expect(byId.get('why')?.action).toBe('oo-why');
    for (const entry of byId.values()) {
      expect(entry.action).not.toContain('`');
      expect(entry.action).not.toContain('→');
    }
  });

  it('falls back to the ref when an entry has no arrow', () => {
    const bare: SkillTemplate<string> = {
      ...SKILL_TEMPLATES[0],
      id: 'estimate',
      blockTriggerLine: 'sizing a change',
    };
    const entry = resolve({ prefix: 'oo', enabledSkills: [bare] }).routing.find(
      (e) => e.id === 'estimate'
    );
    expect(entry?.action).toBe('oo-estimate');
  });

  it('no cloud-gated skill declares a block trigger line', () => {
    // Routing reaches the committed block, so a cloud-gated entry would fork
    // the file between a logged-in author and a teammate without credentials —
    // and vanish from the hook, which never resolves cloud gates at all.
    for (const t of SKILL_TEMPLATES.filter((s) => (s.requires ?? []).includes('cloud'))) {
      expect(t.blockTriggerLine, `"${t.id}" must not contribute a routing entry`).toBeUndefined();
    }
  });
});

describe('enabled-set fallback', () => {
  it('resolves the default-on ungated subset when no set is given', () => {
    const omitted = resolve({ enabledSkills: undefined });
    expect(omitted).toEqual(resolve({ enabledSkills: defaultOn }));
  });

  it('leaks no opt-in or capability-gated ref into the fallback', () => {
    const omitted = resolve({ enabledSkills: undefined });
    const excluded = SKILL_TEMPLATES.filter(
      (s) => s.defaultEnabled === false || (s.requires ?? []).length > 0
    );
    expect(excluded.length).toBeGreaterThan(0);
    for (const t of excluded) {
      expect(omitted.routing.map((e) => e.id)).not.toContain(t.id);
    }
  });
});

describe('hint renderability', () => {
  const skillSets: ReadonlyArray<{
    label: string;
    skills: BootstrapContentInput['enabledSkills'];
  }> = [
    { label: 'default set', skills: undefined },
    { label: 'no skills', skills: [] },
    { label: 'capture only', skills: SKILL_TEMPLATES.filter((s) => s.id === 'capture') },
    { label: 'checkpoint only', skills: SKILL_TEMPLATES.filter((s) => s.id === 'checkpoint') },
    { label: 'every template', skills: SKILL_TEMPLATES },
  ];

  it('renders exactly the keys it does not report as non-rendering', () => {
    for (const { label, skills } of skillSets) {
      for (const commitInsideWindow of [true, false]) {
        const input: HintRenderabilityInput = { enabledSkills: skills, commitInsideWindow };
        const dropped = nonRenderingHintKeys(input);
        for (const hint of CURATED_HINTS) {
          const rendered = resolveBootstrapContent({
            prefix: 'orcaops',
            enabledSkills: skills,
            hints: { keys: [hint.key], custom: [] },
            commitInsideWindow,
            suppressedRouting: [],
          }).hints;
          expect(rendered.length === 1, `${label}/${hint.key}/commit=${commitInsideWindow}`).toBe(
            !dropped.has(hint.key)
          );
        }
      }
    }
  });

  it('names the lifecycle phase that states each hint the default skill set drops', () => {
    const dropped = nonRenderingHintKeys({ enabledSkills: undefined, commitInsideWindow: true });
    expect(dropped.get('capture-on-nontrivial')).toContain('plan lifecycle step');
    expect(dropped.get('open-checkpoint-before-edits')).toContain('checkpoint lifecycle step');
  });

  it('reports only the commit alias when no hint-stating phase is rendered', () => {
    const dropped = nonRenderingHintKeys({ enabledSkills: [], commitInsideWindow: true });
    expect([...dropped.keys()]).toEqual([ALWAYS_DROPPED_HINT_KEY]);
  });

  it('reports the commit alias against the boolean when commit guidance is off', () => {
    const dropped = nonRenderingHintKeys({ enabledSkills: [], commitInsideWindow: false });
    expect(dropped.get(ALWAYS_DROPPED_HINT_KEY)).toContain('commit_inside_window is off');
  });

  it('offers the renderable keys in canonical catalog order', () => {
    const offered = renderableHintKeys({ enabledSkills: undefined, commitInsideWindow: true });
    expect(offered).toEqual(['subagent-parallelism', 'checkpoint-cadence']);
  });
});

describe('workflow hints', () => {
  const keys = [
    'commit-on-checkpoint-close',
    'open-checkpoint-before-edits',
    'capture-on-nontrivial',
    'checkpoint-cadence',
  ] as const;

  it('drops the hints the lifecycle already states', () => {
    const content = resolve({ hints: { keys, custom: ['Prefer small diffs.'] } });
    expect(content.hints).toEqual([
      'Use one checkpoint per coherent unit of work.',
      'Prefer small diffs.',
    ]);
  });

  it('keeps the capture hint when no plan phase is rendered', () => {
    const content = resolve({
      enabledSkills: SKILL_TEMPLATES.filter((s) => s.id !== 'capture'),
      hints: { keys, custom: [] },
    });
    expect(content.lifecycle.map((s) => s.phase)).not.toContain('plan');
    expect(content.hints).toContain(
      'Capture a plan for any non-trivial coding task before starting work.'
    );
    expect(content.hints).not.toContain('Open the checkpoint before changing the worktree.');
  });

  it('keeps the checkpoint hint when no checkpoint phase is rendered', () => {
    const content = resolve({
      enabledSkills: SKILL_TEMPLATES.filter((s) => s.id !== 'checkpoint'),
      hints: { keys, custom: [] },
    });
    expect(content.lifecycle.map((s) => s.phase)).not.toContain('checkpoint');
    expect(content.hints).toContain('Open the checkpoint before changing the worktree.');
  });

  it('never renders the commit hint, whatever the commit flag says', () => {
    const commitProse = 'Open the checkpoint, make changes, run formatters and tests, commit';
    for (const commitInsideWindow of [true, false]) {
      const content = resolve({
        enabledSkills: SKILL_TEMPLATES.filter((s) => s.id !== 'checkpoint'),
        hints: { keys: ['commit-on-checkpoint-close'], custom: [] },
        commitInsideWindow,
      });
      expect(content.hints.some((h) => h.startsWith(commitProse))).toBe(false);
    }
  });

  it('renders nothing when no hints are declared', () => {
    expect(resolve().hints).toEqual([]);
  });
});

describe('commit guidance', () => {
  it('carries the clause in both registers when the flag is on', () => {
    const step = checkpointStep(resolve({ commitInsideWindow: true }));
    expect(step.short).toContain('run tests and commit inside the window');
    expect(step.long).toContain('commit');
  });

  it('drops the clause from both registers when the flag is off', () => {
    const on = checkpointStep(resolve({ commitInsideWindow: true }));
    const off = checkpointStep(resolve({ commitInsideWindow: false }));
    expect(off.short).toBe(
      'Wrap each unit of work with the `orcaops-checkpoint` skill (open before edits; close with what finished).'
    );
    expect(off.short).not.toContain('commit');
    expect(off.long).not.toContain('commit');
    expect(on.long.startsWith(off.long)).toBe(true);
  });
});

describe('lifecycle and prose', () => {
  it('always opens on status and closes on finish', () => {
    expect(resolve().lifecycle.map((s) => s.phase)).toEqual([
      'status',
      'plan',
      'checkpoint',
      'finish',
    ]);
    const bare = resolve({ enabledSkills: [] });
    expect(bare.lifecycle.map((s) => s.phase)).toEqual(['status', 'finish']);
    expect(bare.lifecycle.at(-1)?.long).not.toContain('granular');
    expect(bare.bodiesLocation).toBeNull();
    expect(bare.routing).toEqual([]);
    expect(bare.surveyTail).toBeNull();
  });

  it('threads the prefix through the framing, refs and skill-body location', () => {
    const content = resolve({ prefix: 'oo' });
    expect(content.prefix).toBe('oo');
    expect(content.framing).toContain('`oo-*` skills');
    expect(content.lifecycle.map((s) => s.ref)).toEqual([
      undefined,
      'oo-capture',
      'oo-checkpoint',
      'oo-finish',
    ]);
    expect(content.lifecycle.at(-1)?.long).toContain(
      'The granular **`oo-pre-pr`**, **`oo-summary`**, **`oo-digest`** skills remain'
    );
    expect(content.bodiesLocation).toContain('.claude/skills/oo-*');
    expect(content.attribution).toContain('--invoked-by-agent');
    expect(content.skip.short).toContain('Skip capture for trivial changes');
    expect(content.skip.long).toContain('typo fixes');
  });
});

describe('the routing sentinel', () => {
  it('is the bold label the block formatter emits and the hook tests for', () => {
    expect(ORCAOPS_BLOCK_ROUTING_SENTINEL).toBe('**Read intents → skills.**');
  });
});
