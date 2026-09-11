import { vendorDeclarations } from './vendor-declarations.mjs';

await vendorDeclarations({
  seeds: new Map([
    ['storage/source-plan/canonical-base-url.ts', ['canonicalizeBaseUrl']],
    ['cli/fingerprint-cache.ts', ['DerivedFingerprintCacheEntry', 'computeChecksum']],
    ['storage/source-plan/pull-cache.ts', ['PullCacheRecordSchema', 'PathPointerSchema']],
    ['storage/source-plan/review-pull-cache.ts', ['ReviewPullRecordSchema']],
    ['storage/store/migrations/025-baseline.ts', ['BASELINE_VERSION', 'BASELINE_SCHEMA']],
    [
      'seed/journal.ts',
      [
        'SeedJournalSchema',
        'SeedJournalV1Schema',
        'SeedPreciousStateSchema',
        'SeedCoverageReportSchema',
      ],
    ],
    [
      'seed/enrichment.ts',
      ['SeedEnrichmentSchema', 'PersistedSeedEnrichmentSchema', 'SeedEnrichmentManifestSchema'],
    ],
    ['plan/upload.ts', ['UploadsIndexEntrySchema']],
  ]),
  aliases: new Map([['@orcaops/storage', 'storage/index.ts']]),
  sourcePaths: new Map([
    ['cli/fingerprint-cache.ts', 'apps/orcaops-cli/src/lib/fingerprint-cache.ts'],
    ['seed/journal.ts', 'apps/orcaops-cli/src/commands/seed/journal.ts'],
    ['seed/enrichment.ts', 'apps/orcaops-cli/src/commands/seed/enrichment.ts'],
    ['plan/upload.ts', 'apps/orcaops-cli/src/commands/plan/upload.ts'],
  ]),
  outputRoot: 'src/legacy-operations',
  manifestFile: 'legacy-operational-sources.json',
});
