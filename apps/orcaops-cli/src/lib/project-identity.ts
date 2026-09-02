// Project identity moved into @orcaops/project-scope (shared with the watch
// app). Re-exported wholesale so the CLI's project-identity importers
// (`readProjectId`, `ensureProjectId`, `PROJECT_ID_CONFIG_KEY`, …) keep their
// existing import path unchanged.
export * from '@orcaops/project-scope';
