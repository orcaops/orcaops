import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { SKILL_TEMPLATES } from '@orcaops/adapters';
import type { SemanticAction } from '@orcaops/core';

import { renderNextActions } from './next-actions-render.js';

const skillBody = (id: string): string => {
  const s = SKILL_TEMPLATES.find((t) => t.id === id);
  if (!s) throw new Error(`skill ${id} not found`);
  // A skill body may be a `(prefix) => string` function (the ref-bearing lifecycle skills);
  // resolve it at the default prefix to read the rendered text.
  return typeof s.body === 'function' ? s.body('orcaops') : s.body;
};

const render1 = (a: SemanticAction) => renderNextActions([a])[0];

/** Extract the YAML body between `<<'EOF'` and the trailing `EOF`. */
function heredocBody(command: string): string {
  const m = command.match(/<<'EOF'\n([\s\S]*)\nEOF$/);
  if (!m) throw new Error(`no heredoc body in: ${command}`);
  return m[1];
}

describe('renderNextActions', () => {
  it('output shape is exactly {verb, command, effect}', () => {
    const r = render1({ verb: 'digest', artifact_id: 'A', effect: 'go' });
    expect(Object.keys(r).sort()).toEqual(['command', 'effect', 'verb']);
    expect(r).toMatchObject({ verb: 'digest', effect: 'go' });
  });

  it('checkpoint-open with a SINGLE uncovered step pre-fills the real id (verbatim-runnable)', () => {
    const r = render1({
      verb: 'checkpoint-open',
      artifact_id: 'A',
      step_ids: ['s1'],
      effect: 'e',
    });
    expect(r.command).toContain("capture checkpoint open --input - <<'EOF'");
    expect(r.command).toContain('declared_step_ids: [ s1 ]');
    expect(r.command).not.toContain('--json');
    expect(r.command).not.toContain('<next-coherent-subset>');
    // Body must be valid YAML with the real id pre-filled.
    expect(parseYaml(heredocBody(r.command))).toMatchObject({
      artifact_id: 'A',
      declared_step_ids: ['s1'],
    });
  });

  it('checkpoint-open with MULTIPLE uncovered steps renders a choose-a-subset placeholder, NOT the real ids', () => {
    const r = render1({
      verb: 'checkpoint-open',
      artifact_id: 'A',
      step_ids: ['s1', 's2', 's3'],
      effect: 'e',
    });
    expect(r.command).toContain("capture checkpoint open --input - <<'EOF'");
    expect(r.command).toContain('<next-coherent-subset>');
    expect(r.command).not.toContain('--json');
    // The real ids must NOT be pasted into the command body — that's the foot-gun.
    expect(r.command).not.toContain('s1');
    expect(r.command).not.toContain('s2');
    expect(r.command).not.toContain('s3');
    // Parse the body (not just substring-match) so a wrong field name or invalid
    // YAML is caught: only the placeholder should be carried, no real ids.
    expect(parseYaml(heredocBody(r.command))).toMatchObject({
      artifact_id: 'A',
      declared_step_ids: ['<next-coherent-subset>'],
    });
  });

  it('checkpoint-open retry renders a remediation template, NOT the rejected scope', () => {
    const r = render1({
      verb: 'checkpoint-open',
      artifact_id: 'A',
      retry_reason: 'open-rejected',
      step_ids: ['rejected-1', 'rejected-2'],
      policy_exception_refs: ['core/scope-density'],
      effect: 'e',
    });
    expect(r.command).toContain('<smaller-step-subset>');
    expect(r.command).toContain('policy_exceptions:');
    expect(r.command).toContain('core/scope-density');
    // The rejected scope must not appear as a runnable value.
    expect(r.command).not.toContain('rejected-1');
    const body = parseYaml(heredocBody(r.command)) as Record<string, unknown>;
    expect(body.artifact_id).toBe('A');
    expect(body.policy_exceptions).toEqual([
      { evaluator: 'core/scope-density', reason: '<why this scope is intentional>' },
    ]);
  });

  it('checkpoint-close includes n + completed_step_ids and parses as YAML', () => {
    const r = render1({
      verb: 'checkpoint-close',
      artifact_id: 'A',
      checkpoint_n: 3,
      step_ids: ['s1'],
      effect: 'e',
    });
    expect(r.command).toContain('capture checkpoint close --input -');
    const body = parseYaml(heredocBody(r.command)) as Record<string, unknown>;
    expect(body).toMatchObject({ artifact_id: 'A', n: 3, completed_step_ids: ['s1'] });
    expect(typeof body.summary).toBe('string');
  });

  it('digest renders the flag form', () => {
    expect(render1({ verb: 'digest', artifact_id: 'A', effect: 'e' }).command).toBe(
      'orcaops digest --artifact A'
    );
  });

  it('evaluator errors render a phase rerun instead of a disposition command', () => {
    const r = render1({
      verb: 'evaluator-rerun',
      artifact_id: 'A',
      evaluator_ref: 'core/x',
      run_id: 'r-error',
      evaluator_phase: 'checkpoint-close',
      checkpoint_n: 3,
      effect: 'e',
    });
    expect(r.command).toContain('capture run-evaluators --input -');
    expect(parseYaml(heredocBody(r.command))).toMatchObject({
      artifact_id: 'A',
      fires_at: 'checkpoint-close',
      checkpoint_n: 3,
    });
    expect(r.command).not.toContain('block acknowledge');
    expect(r.command).not.toContain('block dismiss');

    const prePr = render1({
      verb: 'evaluator-rerun',
      artifact_id: 'A',
      evaluator_ref: 'core/x',
      run_id: 'r-error',
      evaluator_phase: 'pre-pr',
      effect: 'e',
    });
    expect(prePr.command).toContain('capture pre-pr-check --input -');
  });

  it('block verbs render --evaluator/--run-id/--reason flags (not heredocs)', () => {
    const ack = render1({
      verb: 'block-acknowledge',
      artifact_id: 'A',
      evaluator_ref: 'core/x',
      run_id: 'r1',
      effect: 'e',
    });
    expect(ack.command).toBe(
      'orcaops block acknowledge --artifact A --evaluator core/x --run-id r1 --reason "<why you accept this finding>"'
    );
    const dis = render1({
      verb: 'block-dismiss',
      artifact_id: 'A',
      evaluator_ref: 'core/x',
      effect: 'e',
    });
    // No run_id → omit --run-id.
    expect(dis.command).toBe(
      'orcaops block dismiss --artifact A --evaluator core/x --reason "<why this is a false positive>"'
    );
  });

  // Drift guard: the capture-verb syntax the renderer emits must match the
  // canonical adapters skill bodies (YAML `--input -`). If the skills change
  // surface, these assertions fail → reconcile renderNextActions.
  it('capture-verb syntax matches the adapters skill bodies (YAML --input - surface)', () => {
    const cp = skillBody('checkpoint');
    expect(cp).toContain('capture checkpoint open --input -');
    expect(cp).toContain('capture checkpoint close --input -');
    expect(
      render1({ verb: 'checkpoint-open', artifact_id: 'A', step_ids: ['s'], effect: 'e' }).command
    ).toContain('capture checkpoint open --input -');
    expect(
      render1({
        verb: 'checkpoint-close',
        artifact_id: 'A',
        checkpoint_n: 1,
        step_ids: ['s'],
        effect: 'e',
      }).command
    ).toContain('capture checkpoint close --input -');
  });
});
