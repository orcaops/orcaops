import { describe, expect, it } from 'vitest';

import type {
  EvaluatorConfig,
  EvaluatorRunPayload,
  ResolvedEvaluator,
} from '@orcaops/evaluator-protocol';
import { EvaluatorDiscoveryError } from '@orcaops/evaluator-runner';

import {
  LIFECYCLE_INVENTORY_EVALUATOR_REF,
  reconcileLifecycleEvaluatorInventory,
} from './evaluator-inventory.js';

const config = (refs: string[]): EvaluatorConfig => ({
  schema: 'orcaops.evaluator_config/v2',
  runtime: { max_concurrent: 4 },
  packages: [{ id: 'core', source: { kind: 'bundled', package: 'pkg', pack: 'core' } }],
  evaluators: Object.fromEntries(refs.map((ref) => [ref, { enabled: true }])),
});

const evaluator = (ref: string): ResolvedEvaluator => ({
  ref,
  package_id: ref.split('/')[0]!,
  evaluator_id: ref.split('/')[1]!,
  package_root: '/tmp/pack',
  spec_path: `/tmp/pack/${ref.split('/')[1]}.eval.yaml`,
  description: 'fixture evaluator',
  enabled: true,
  phase: 'checkpoint-close',
  severity: 'block',
  engine: {
    kind: 'command',
    command: ['true'],
    cwd: 'repo',
    timeout_ms: 1000,
    max_output_bytes: 1024,
    env: { inherit: [], set: {} },
  },
  filters: { paths: [], scopes: [], when_llm: 'optional' },
  params: {},
  fingerprint_include: [],
  resolution: {
    acknowledge: { enabled: false },
    policy_exception: { enabled: false },
  },
});

const completedRun = (ref: string): EvaluatorRunPayload => ({
  schema: 'orcaops.evaluator_run/v1',
  run_id: `run-${ref.replace('/', '-')}`,
  artifact_id: 'artifact-test',
  evaluator_ref: ref,
  package_id: ref.split('/')[0]!,
  evaluator_id: ref.split('/')[1]!,
  phase: 'checkpoint-close',
  severity: 'block',
  run_status: 'completed',
  verdict: 'pass',
  body: 'PASS',
  ts: '2026-07-15T00:00:00.000Z',
});

const failedRun = (ref: string, severity: 'info' | 'warn' | 'block'): EvaluatorRunPayload => ({
  ...completedRun(ref),
  severity,
  run_status: 'error',
  verdict: null,
  body: 'ERROR (TIMEOUT)',
  error: { code: 'TIMEOUT', message: 'evaluator timed out' },
});

function reconcile(input: {
  configured: string[];
  discovered?: ResolvedEvaluator[];
  eligible?: ResolvedEvaluator[];
  runs?: EvaluatorRunPayload[];
  discoveryErrors?: EvaluatorDiscoveryError[];
}) {
  let ordinal = 0;
  return reconcileLifecycleEvaluatorInventory({
    artifactId: 'artifact-test',
    phase: 'checkpoint-close',
    checkpointN: 5,
    config: config(input.configured),
    discovered: input.discovered ?? [],
    eligible: input.eligible ?? [],
    dispatchedRuns: input.runs ?? [],
    discoveryErrors: input.discoveryErrors ?? [],
    runIdFactory: () => `inventory-run-${++ordinal}`,
    now: '2026-07-15T00:00:00.000Z',
  });
}

describe('lifecycle evaluator inventory', () => {
  it('fails closed when an enabled configured ref is absent from the executing pack', () => {
    const result = reconcile({ configured: ['core/checkpoint-scope-density'] });
    expect(result.complete).toBe(false);
    expect(result.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evaluator_ref: 'core/checkpoint-scope-density',
          run_status: 'error',
          error: expect.objectContaining({ code: 'EVALUATOR_REF_UNRESOLVED' }),
        }),
        expect.objectContaining({
          evaluator_ref: LIFECYCLE_INVENTORY_EVALUATOR_REF,
          severity: 'block',
          verdict: 'violation',
        }),
      ])
    );
  });

  it('redacts discovery errors in supplemental and inventory run payloads', () => {
    const secret = 'ghp_0000000000000000000000000000000000000';
    const result = reconcile({
      configured: [],
      discoveryErrors: [
        new EvaluatorDiscoveryError({
          source_path: `/tmp/${secret}.eval.yaml`,
          message: `invalid evaluator containing ${secret}`,
        }),
      ],
    });

    expect(result.complete).toBe(false);
    expect(JSON.stringify(result.runs)).not.toContain(secret);
    expect(JSON.stringify(result.runs)).toContain('REDACTED');
  });

  it('fails closed when dispatch omits an eligible evaluator outcome', () => {
    const expected = evaluator('core/checkpoint-scope-density');
    const result = reconcile({
      configured: [expected.ref],
      discovered: [expected],
      eligible: [expected],
    });
    expect(result.complete).toBe(false);
    expect(result.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evaluator_ref: expected.ref,
          run_status: 'error',
          error: expect.objectContaining({ code: 'EVALUATOR_RUN_MISSING' }),
        }),
        expect.objectContaining({
          evaluator_ref: LIFECYCLE_INVENTORY_EVALUATOR_REF,
          verdict: 'violation',
        }),
      ])
    );
  });

  it('records a blocking pass when every eligible evaluator has exactly one outcome', () => {
    const expected = evaluator('core/checkpoint-scope-density');
    const result = reconcile({
      configured: [expected.ref],
      discovered: [expected],
      eligible: [expected],
      runs: [completedRun(expected.ref)],
    });
    expect(result.complete).toBe(true);
    expect(result.runs).toHaveLength(2);
    expect(result.runs.at(-1)).toMatchObject({
      evaluator_ref: LIFECYCLE_INVENTORY_EVALUATOR_REF,
      severity: 'block',
      verdict: 'pass',
    });
  });

  it('fails closed when a block-severity eligible evaluator errors', () => {
    const expected = evaluator('core/checkpoint-scope-density');
    const result = reconcile({
      configured: [expected.ref],
      discovered: [expected],
      eligible: [expected],
      runs: [failedRun(expected.ref, 'block')],
    });

    expect(result.complete).toBe(false);
    expect(result.runs.at(-1)).toMatchObject({
      evaluator_ref: LIFECYCLE_INVENTORY_EVALUATOR_REF,
      verdict: 'violation',
    });
  });

  it('records incomplete info instead of a false pass for a non-blocking evaluator error', () => {
    const expected = { ...evaluator('core/advisory'), severity: 'warn' as const };
    const result = reconcile({
      configured: [expected.ref],
      discovered: [expected],
      eligible: [expected],
      runs: [failedRun(expected.ref, 'warn')],
    });

    expect(result.complete).toBe(false);
    expect(result.runs.at(-1)).toMatchObject({
      evaluator_ref: LIFECYCLE_INVENTORY_EVALUATOR_REF,
      verdict: 'info',
    });
  });
});
