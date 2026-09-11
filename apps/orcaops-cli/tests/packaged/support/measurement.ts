import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect } from 'vitest';

import type { CeilingName } from './ceilings.js';
import { ceilings } from './ceilings.js';

const execute = promisify(execFile);

export type Measurement = {
  label: string;
  wallMs: number;
  /** Raw `uptime` output taken beside the measurement, load averages included. */
  uptime: string;
  at: string;
};

export type ScenarioRecord = {
  scenario: string;
  file: string;
  measurements: Measurement[];
  /** The ceilings this scenario relied on, so the report can name every one. */
  ceilings: Partial<Record<CeilingName, number>>;
  /** Retry counts the scenario actually observed, not a claim about the ceiling. */
  retries: Record<string, number>;
  processes: { role: string; pid: number; exit?: number | null; signal?: string | null }[];
  notes: string[];
};

export async function machineLoad(): Promise<string> {
  const { stdout } = await execute('uptime', []);
  return stdout.trim();
}

let current: ScenarioRecord | undefined;

/**
 * Opens the per-scenario record. Every scenario calls this first; the record is
 * flushed in afterEach to `PACKAGED_GATE_LOG_DIR` when that is set, so a failing
 * run leaves the same evidence a passing one does. The name deliberately avoids
 * the `ORCAOPS_` prefix: vitest.cli-setup.ts scrubs every ambient ORCAOPS_* var
 * out of the worker, so a prefixed name would never reach this module.
 */
export function scenario(name: string, file: string): ScenarioRecord {
  current = {
    scenario: name,
    file,
    measurements: [],
    ceilings: {},
    retries: {},
    processes: [],
    notes: [],
  };
  return current;
}

export function useCeiling(record: ScenarioRecord, name: CeilingName): number {
  record.ceilings[name] = ceilings[name];
  return ceilings[name];
}

export function noteProcess(
  record: ScenarioRecord,
  role: string,
  pid: number,
  exit?: { code: number | null; signal: NodeJS.Signals | null }
) {
  record.processes.push({ role, pid, exit: exit?.code ?? null, signal: exit?.signal ?? null });
}

export async function measure<T>(
  record: ScenarioRecord,
  label: string,
  work: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    record.measurements.push({
      label,
      wallMs: Date.now() - started,
      uptime: await machineLoad(),
      at: new Date().toISOString(),
    });
  }
}

/**
 * Asserts an observed duration is inside a named ceiling AND records it. This is
 * how the timeliness properties (cancellation between short attempts) become
 * assertions rather than guards.
 */
export function withinCeiling(record: ScenarioRecord, name: CeilingName, observedMs: number) {
  const ceiling = useCeiling(record, name);
  expect(observedMs).toBeLessThanOrEqual(ceiling);
}

afterEach(async () => {
  const record = current;
  current = undefined;
  const directory = process.env.PACKAGED_GATE_LOG_DIR;
  if (!record || !directory) return;
  await mkdir(directory, { recursive: true });
  await appendFile(path.join(directory, 'scenarios.ndjson'), `${JSON.stringify(record)}\n`);
});
