export function terminalRunFileSeed(input: {
  runId: string;
  branch: string;
  finalizedAt: string;
  inputShas?: Record<string, string>;
}) {
  return {
    schema_version: 2,
    run_id: input.runId,
    branch: input.branch,
    mode: 'routine',
    created_at: '2026-07-23T09:00:00.000Z',
    input_shas: input.inputShas ?? { dossier: 'dossier', projection: 'projection' },
    slice_state: {
      schema_version: 5,
      lanes: {
        account: {
          attempts: 0,
          accepted: false,
          repairCredit: 1,
          outcome: 'PENDING',
          diagnostics: [],
        },
        forensic: {
          attempts: 0,
          accepted: false,
          repairCredit: 1,
          outcome: 'PENDING',
          diagnostics: [],
        },
      },
    },
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
  } as const;
}
