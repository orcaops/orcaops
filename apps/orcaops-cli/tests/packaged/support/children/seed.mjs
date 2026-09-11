// Seeds a disposable project store: creates the SQLite database, registration
// marker and catalog entry, then writes plan artifacts the packaged commands can
// act on. It runs as its own process and exits, so no scenario ever contends with
// a database handle the test runner is still holding open.
//
// Seeding uses the compiled private API because no public command initializes a
// project store at this base (`orcaops init` writes only the legacy config and
// projects.json). The scenario under test is always the packaged process, never
// this seeder.
const input = JSON.parse(process.argv[2]);

const { setupProjectDatabase } = await import(input.modules.databaseSetup);
const { requireDatabaseExecutionContext } = await import(input.modules.databaseContext);
const { PlanInputSchema, uuidv7 } = await import(input.modules.storage);
const { openProjectDatabase } = await import(input.modules.storageDatabase);
const { prepareArtifactDraft } = await import(input.modules.draftPreparation);
const { appendProjectExecutionCapture } = await import(input.modules.executionCapture);

const setup = await setupProjectDatabase({
  cwd: input.cwd,
  root: input.root,
  ...(input.projectId ? { projectId: input.projectId } : {}),
  authoredPayloads: [],
  secretAllow: [],
});
if (setup.status !== 'complete')
  throw Object.assign(new Error(`Seed setup returned ${setup.status}`), { setup });

const authority = setup.initialization.authority;
const context = await requireDatabaseExecutionContext({
  cwd: input.cwd,
  root: authority.resolvedRoot,
});
const writer = await openProjectDatabase({ authority, mode: 'writer' });
const artifactIds = [];
try {
  for (let index = 0; index < (input.artifacts ?? 0); index += 1) {
    const artifactId = uuidv7();
    const operationId = uuidv7();
    const ts = input.ts ?? '2026-09-07T00:00:00.000Z';
    const plan = PlanInputSchema.parse({
      schema_version: 4,
      artifact_id: artifactId,
      branch: context.binding.git_context.branch ?? 'HEAD',
      base_sha: context.binding.git_context.head_sha,
      agent: 'codex',
      agent_session_id: null,
      task: 'Retain packaged gate narrative',
      label: `Packaged gate ${index + 1}`,
      plan_steps: [
        {
          step_id: uuidv7(),
          text: 'Observe the packaged surface',
          label: 'Observe',
          acceptance_criteria: [],
        },
      ],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      started_at: ts,
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      prior_plan_event_id: null,
    });
    const draft = await prepareArtifactDraft(
      {
        artifactId,
        priorEvents: [],
        authoredPayload: { plan, sourcePlan: null },
        secretAllow: [],
        idempotencyBlocks: [],
      },
      (semantics) => semantics.writePlan(plan, { idempotencyKey: operationId })
    );
    if (draft.evaluation.kind === 'threw') throw draft.evaluation.error;
    const event = draft.events[0];
    if (!event || draft.events.length !== 1)
      throw new Error('Seed plan did not prepare exactly one event');
    await appendProjectExecutionCapture(writer, {
      artifactId,
      operationId,
      expectedRevision: null,
      eventBytes: event.eventBytes,
      sidecarPayloads: event.sidecar
        ? [{ eventId: event.record.event_id, bytes: event.sidecar.bytes }]
        : [],
      secretAllow: [],
      execution: { kind: 'create', context: context.binding, ts },
    });
    artifactIds.push(artifactId);
  }
} finally {
  writer.close();
}

process.stdout.write(
  `${JSON.stringify({
    projectId: authority.projectId,
    resolvedRoot: authority.resolvedRoot,
    storeInstanceId: authority.storeInstanceId,
    repositoryInstanceId: authority.repositoryInstanceId,
    databasePath: writer.databasePath,
    artifactIds,
  })}\n`
);
