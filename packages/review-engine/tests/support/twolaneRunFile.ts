import { TWOLANE_RUN_SCHEMA_VERSION, type TwolaneRunFile } from '../../src/twolaneRunFile.js';
import { freshSliceRunState } from '../../src/twolaneSlice.js';

/**
 * A complete finalized run file for test seeds. The persisted run-file schema
 * is strict (every key the writer emits is required), so seeds must mirror the
 * writer's full output — one typed builder keeps a schema change a single
 * compile error instead of a hand-edit hunt across suites.
 *
 * Fixture timestamps and shas are intentionally baked in for test seeds.
 */
export function terminalRunFileSeed(input: {
  runId: string;
  branch: string;
  finalizedAt: string;
  inputShas?: Record<string, string>;
}): TwolaneRunFile {
  return {
    schema_version: TWOLANE_RUN_SCHEMA_VERSION,
    run_id: input.runId,
    branch: input.branch,
    mode: 'routine',
    created_at: '2026-07-23T09:00:00.000Z',
    input_shas: input.inputShas ?? { dossier: 'dossier', projection: 'projection' },
    slice_state: freshSliceRunState(),
    lane_inputs_served: {},
    attempts: [],
    account_lineage: null,
    latency_input_bytes: 0,
    runtime_identity: null,
    execution_profile: {
      host: null,
      host_version: null,
      model: null,
      effort: null,
      launcher_mode: null,
      instruction_hash: null,
    },
    finalized: { at: input.finalizedAt, outcome: 'FULL' },
  };
}
