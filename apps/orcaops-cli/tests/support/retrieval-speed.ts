import { stat } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';

import { normalizeSearchQuery } from '@orcaops/core/history/search';
import { queryProjectSearch } from '@orcaops/storage/history/database';

import type { RetrievalCorpus } from './retrieval-corpus.js';
import { searchArgs } from './retrieval-matching.js';
import { CLI_VERSION } from '../../src/lib/cli-version.js';
import type { RetrievalCase } from '../fixtures/retrieval-corpus/cases.js';

export interface Timing {
  samples: number;
  medianMs: number;
  p95Ms: number;
}

export interface SpeedMeasurement {
  tool: { cli: string; node: string; platform: string; arch: string; cpu: string };
  storage: { eventBytes: number; databaseFileBytes: number; writeAheadLogBytes: number };
  scan: {
    includes: string;
    repetitions: number;
    perQuery: Array<Timing & { query: string; scannedRows: number; matchedRows: number }>;
    overall: Timing;
  };
  /** The same scan confined to one artifact, to tell the fixed cost of a call from the per-row cost. */
  oneArtifactScan: { scannedRows: number; repetitions: number; overall: Timing };
  perRowEstimate: { fixedMs: number; perRowMs: number; basis: string };
  command: { includes: string; overall: Timing };
}

function timingOf(samples: number[]): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (quantile: number) => sorted[Math.ceil(quantile * sorted.length) - 1]!;
  return {
    samples: sorted.length,
    medianMs: Number(at(0.5).toFixed(3)),
    p95Ms: Number(at(0.95).toFixed(3)),
  };
}

async function fileBytes(file: string): Promise<number> {
  return (await stat(file).catch(() => null))?.size ?? 0;
}

/**
 * Times the storage scan behind `search` directly against the corpus history, apart from any
 * scoring. Numbers describe this machine and this small corpus; nothing asserts on them.
 */
export async function measureScanSpeed(
  corpus: RetrievalCorpus,
  cases: readonly RetrievalCase[],
  repetitions = 25
): Promise<SpeedMeasurement> {
  const queries = [...new Set(cases.flatMap((retrievalCase) => retrievalCase.queries))];
  const artifacts = Object.values(corpus.artifacts);
  const database = await corpus.openDatabase();
  try {
    // The command asks storage for one row past its page to learn whether more exist.
    const scan = (query: string, artifactIds?: string[]) =>
      queryProjectSearch(database, {
        query: normalizeSearchQuery(query),
        origin: 'captured',
        limit: 26,
        ...(artifactIds ? { artifactIds } : {}),
      });
    const allScanSamples: number[] = [];
    const perQuery = queries.map((query) => {
      const warm = scan(query);
      const samples: number[] = [];
      for (let repetition = 0; repetition < repetitions; repetition++) {
        const started = performance.now();
        scan(query);
        samples.push(performance.now() - started);
      }
      allScanSamples.push(...samples);
      return {
        query,
        scannedRows: warm.scanned,
        matchedRows: warm.rows.length,
        ...timingOf(samples),
      };
    });

    const largest = artifacts.reduce((a, b) => (b.events.length > a.events.length ? b : a));
    const oneArtifactRepetitions = 10;
    const oneArtifactSamples: number[] = [];
    let oneArtifactRows = 0;
    for (const query of queries) {
      oneArtifactRows = scan(query, [largest.artifactId]).scanned;
      for (let repetition = 0; repetition < oneArtifactRepetitions; repetition++) {
        const started = performance.now();
        scan(query, [largest.artifactId]);
        oneArtifactSamples.push(performance.now() - started);
      }
    }
    const whole = timingOf(allScanSamples);
    const oneArtifact = timingOf(oneArtifactSamples);
    const wholeRows = perQuery[0]?.scannedRows ?? 0;
    const perRowMs = (whole.medianMs - oneArtifact.medianMs) / (wholeRows - oneArtifactRows);

    const commandSamples: number[] = [];
    for (const query of queries) {
      const started = performance.now();
      await corpus.agent.runRaw(searchArgs(query, 'default'));
      commandSamples.push(performance.now() - started);
    }

    return {
      tool: {
        cli: `@orcaops/cli ${CLI_VERSION}`,
        node: process.version,
        platform: `${platform()} ${release()}`,
        arch: arch(),
        cpu: cpus()[0]?.model ?? 'unknown',
      },
      storage: {
        eventBytes: artifacts.reduce((sum, artifact) => sum + artifact.eventBytes, 0),
        databaseFileBytes: await fileBytes(database.databasePath),
        writeAheadLogBytes: await fileBytes(`${database.databasePath}-wal`),
      },
      scan: {
        includes:
          'queryProjectSearch on an open reader: input validation, the database path assertion, the revision, query-metadata and search-index validity checks over the selected artifacts, the registered match function over every candidate row for the counts and again for the returned rows, ordering, the row limit, the unknown-association count (constant here, with no worktree filter), and the project counters read. No process start, database open, hit rendering, or JSON output.',
        repetitions,
        perQuery,
        overall: whole,
      },
      oneArtifactScan: {
        scannedRows: oneArtifactRows,
        repetitions: oneArtifactRepetitions,
        overall: oneArtifact,
      },
      perRowEstimate: {
        fixedMs: Number((oneArtifact.medianMs - perRowMs * oneArtifactRows).toFixed(3)),
        perRowMs: Number(perRowMs.toFixed(4)),
        basis: `A line through two medians, ${oneArtifactRows} and ${wholeRows} scanned rows. The validity checks grow with the number of selected artifacts and are charged to rows here, and events are small: an order of magnitude at most.`,
      },
      command: {
        includes:
          'One in-process run per query of the invocation the matching pass uses at the default limit: program construction, scope resolution, database open and close, the scan, hit rendering, and JSON output. No process start.',
        overall: timingOf(commandSamples),
      },
    };
  } finally {
    database.close();
  }
}
