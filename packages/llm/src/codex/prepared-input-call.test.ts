import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type PreparedInputCallFailed,
  type PreparedInputCallOptions,
  runPreparedInputCall,
} from '../prepared-input-call.js';

const IS_WINDOWS = process.platform === 'win32';
const FIXTURE = fileURLToPath(new URL('../fixtures/fake-codex-provider.mjs', import.meta.url));

let scratch: string;
let providerPath: string;
let recordPath: string;
let preflightMarker: string;
let modelMarker: string;
let codexHome: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'orcaops-codex-prepared-test-')));
  providerPath = path.join(scratch, 'codex');
  recordPath = path.join(scratch, 'record.json');
  preflightMarker = path.join(scratch, 'preflight');
  modelMarker = path.join(scratch, 'model');
  codexHome = path.join(scratch, 'codex-home');
  await mkdir(codexHome);
  const packageDir = path.join(scratch, 'package');
  await mkdir(packageDir);
  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@openai/codex',
      type: 'module',
      bin: { codex: 'codex.js' },
    })
  );
  await copyFile(FIXTURE, path.join(packageDir, 'codex.js'));
  await symlink(path.join(packageDir, 'codex.js'), providerPath);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function options(overrides: Partial<PreparedInputCallOptions> = {}): PreparedInputCallOptions {
  return {
    provider: 'codex',
    toolAccess: 'codex_restricted',
    preparedInput: 'Prepared facts only.',
    instructions: 'Return one JSON object.',
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 16 * 1024,
    timeoutMs: 20_000,
    killGraceMs: 100,
    scratchParentDir: scratch,
    env: {
      ...process.env,
      ORCAOPS_CODEX_PATH: providerPath,
      CODEX_HOME: codexHome,
      FAKE_CODEX_RECORD: recordPath,
      FAKE_CODEX_PREFLIGHT_MARKER: preflightMarker,
      FAKE_CODEX_MODEL_MARKER: modelMarker,
    },
    ...overrides,
  };
}

function failed(result: Awaited<ReturnType<typeof runPreparedInputCall>>): PreparedInputCallFailed {
  if (result.status !== 'failed') throw new Error(`expected failure: ${JSON.stringify(result)}`);
  return result;
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(IS_WINDOWS)('runPreparedInputCall with restricted Codex', () => {
  it('skips unknown launchers on PATH for both the preflight and the model call', async () => {
    const launcherDir = path.join(scratch, 'launcher');
    await mkdir(launcherDir);
    await writeFile(path.join(launcherDir, 'codex'), '#!/bin/sh\nexit 99\n', {
      mode: 0o755,
    });
    const result = await runPreparedInputCall(
      options({
        env: {
          ...options().env,
          ORCAOPS_CODEX_PATH: undefined,
          PATH: [launcherDir, scratch].join(path.delimiter),
        },
      })
    );

    expect(result.status).toBe('completed');
    expect(existsSync(preflightMarker)).toBe(true);
    expect(existsSync(modelMarker)).toBe(true);
  });

  it('refuses an explicitly selected launcher without replacing it', async () => {
    await rm(providerPath);
    await writeFile(providerPath, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const result = failed(await runPreparedInputCall(options()));

    expect(result.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.message).toContain('ORCAOPS_CODEX_PATH=');
    expect(result.message).toContain('unsupported launcher');
    expect(result.providerStarted).toBe(false);
    expect(existsSync(preflightMarker)).toBe(false);
    expect(existsSync(modelMarker)).toBe(false);
  });

  it('refuses a PATH containing only an unknown launcher', async () => {
    await rm(providerPath);
    await writeFile(providerPath, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const result = failed(
      await runPreparedInputCall(
        options({ env: { ...options().env, ORCAOPS_CODEX_PATH: undefined, PATH: scratch } })
      )
    );

    expect(result.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.message).toContain('unsupported launcher');
    expect(result.providerStarted).toBe(false);
  });

  it('runs a compatible CLI with exact settings and accepts an answer without a tool catalog', async () => {
    const processes: Array<{ pid: number; processGroupId: number | null }> = [];
    const result = await runPreparedInputCall(
      options({
        explicitModel: 'gpt-exact',
        explicitEffort: 'high',
        outputSchema: { type: 'object' },
        onProviderProcess: (process) => processes.push(process),
      })
    );
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      argv: string[];
      cwd: string;
      stdin: string;
      schemaPath: string;
      schema: string;
    };

    expect(result).toMatchObject({
      status: 'completed',
      provider: 'codex',
      body: '{"statements":[]}',
      usage: { in: 30, out: 8, cacheRead: 20 },
      costUsd: null,
      settings: { toolAccess: 'codex_restricted' },
    });
    expect(record.stdin).toBe('Return one JSON object.\n\nPrepared facts only.');
    expect(record.argv).toContain('gpt-exact');
    expect(record.argv).toContain('model_reasoning_effort="high"');
    expect(record.argv).not.toContain('--sandbox');
    expect(record.schema).toBe('{"type":"object"}');
    expect(path.dirname(record.schemaPath)).toBe(record.cwd);
    expect(existsSync(record.cwd)).toBe(false);
    expect(existsSync(preflightMarker)).toBe(true);
    expect(existsSync(modelMarker)).toBe(true);
    expect(processes).toHaveLength(1);
    expect(processes[0]?.pid).toBeGreaterThan(0);
    expect(processes[0]?.processGroupId).toBe(processes[0]?.pid);
  });

  it('rejects observed tool use and discards the answer', async () => {
    const env = { ...options().env, FAKE_CODEX_BEHAVIOR: 'tool-use' };
    const result = failed(await runPreparedInputCall(options({ env, retainFailureOutput: true })));

    expect(result.code).toBe('TOOL_USE_OBSERVED');
    expect(result.message).toMatch(/restricted Codex mode.*command_execution/);
    expect(result).not.toHaveProperty('body');
    expect(result.failureOutput?.stdout.text).toContain('command_execution');
  });

  it('repairs a completed structured answer and retains its original bytes and edits', async () => {
    const original = '{"statements":[],}';
    const result = await runPreparedInputCall(
      options({
        env: { ...options().env, FAKE_CODEX_ANSWER: original },
        outputSchema: { type: 'object' },
      })
    );
    expect(result).toMatchObject({
      status: 'completed',
      body: '{"statements":[]}',
      jsonRepair: { originalBody: original, edits: [{ offset: 16, removed: ',', inserted: '' }] },
      outputBytes: 17,
    });
    expect((await readFile(modelMarker, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('leaves unsupported JSON damage as a structured-answer failure', async () => {
    const original = '{"statements":[';
    const result = failed(
      await runPreparedInputCall(
        options({
          env: { ...options().env, FAKE_CODEX_ANSWER: original },
          outputSchema: { type: 'object' },
          retainFailureOutput: true,
        })
      )
    );
    expect(result.code).toBe('STRUCTURED_ANSWER_MISSING');
    expect(result).not.toHaveProperty('jsonRepair');
    expect(result.failureOutput?.stdout.text).toContain('turn.completed');
  });

  it('never rescues an answer from a tool-using call', async () => {
    const result = failed(
      await runPreparedInputCall(
        options({
          env: {
            ...options().env,
            FAKE_CODEX_BEHAVIOR: 'tool-use',
            FAKE_CODEX_ANSWER: '{"statements":[],}',
          },
          outputSchema: { type: 'object' },
        })
      )
    );
    expect(result.code).toBe('TOOL_USE_OBSERVED');
    expect(result).not.toHaveProperty('jsonRepair');
  });

  it('enforces both the original and repaired answer byte bounds', async () => {
    for (const [body, maxOutputBytes] of [
      ['{"a":1,}', 7],
      ['[0 1]', 5],
    ] as const) {
      const result = await runPreparedInputCall(
        options({
          env: { ...options().env, FAKE_CODEX_ANSWER: body },
          outputSchema: { type: 'object' },
          maxOutputBytes,
        })
      );
      expect(result.status).toBe('failed');
      expect(result).not.toHaveProperty('body');
    }
  });

  it('keeps failed provider output private unless diagnostics are explicitly requested', async () => {
    const env = { ...options().env, FAKE_CODEX_BEHAVIOR: 'free-text' };
    const result = failed(
      await runPreparedInputCall(options({ env, outputSchema: { type: 'object' } }))
    );

    expect(result.code).toBe('STRUCTURED_ANSWER_MISSING');
    expect(result).not.toHaveProperty('body');
    expect(result).not.toHaveProperty('failureOutput');
  });

  it.each(['free-text', 'missing-answer'])(
    'retains the bounded stream for a %s failure without accepting it as an answer',
    async (behavior) => {
      const env = { ...options().env, FAKE_CODEX_BEHAVIOR: behavior };
      const result = failed(
        await runPreparedInputCall(
          options({ env, outputSchema: { type: 'object' }, retainFailureOutput: true })
        )
      );

      expect(result.code).toBe('STRUCTURED_ANSWER_MISSING');
      expect(result).not.toHaveProperty('body');
      expect(result.failureOutput?.format).toBe('scrubbed-stream-tails/v1');
      expect(result.failureOutput?.stdout.text).toContain('turn.completed');
      expect(result.failureOutput?.stdout.truncated).toBe(false);
      expect(result.failureOutput?.stderr).toEqual({
        text: '',
        originalBytes: 0,
        truncated: false,
      });
      if (behavior === 'free-text')
        expect(result.failureOutput?.stdout.text).toContain('I cannot provide that JSON answer.');
      else expect(result.failureOutput?.stdout.text).not.toContain('agent_message');
    }
  );

  it('scrubs failed output before taking byte-bounded Unicode-safe tails', async () => {
    const env = { ...options().env, FAKE_CODEX_BEHAVIOR: 'diagnostic-output' };
    const result = failed(
      await runPreparedInputCall(
        options({ env, outputSchema: { type: 'object' }, retainFailureOutput: true })
      )
    );
    const output = result.failureOutput!;

    expect(result.code).toBe('STRUCTURED_ANSWER_MISSING');
    expect(output.stdout.originalBytes).toBeGreaterThan(64 * 1024);
    expect(output.stderr.originalBytes).toBeGreaterThan(8 * 1024);
    expect(Buffer.byteLength(output.stdout.text)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(output.stderr.text)).toBeLessThanOrEqual(8 * 1024);
    for (const stream of [output.stdout, output.stderr]) {
      expect(stream.truncated).toBe(true);
      expect(stream.text.includes('ghp_')).toBe(false);
      expect(stream.text.includes('[REDACTED_SECRET]')).toBe(true);
      expect(stream.text.includes('\u001b')).toBe(false);
      expect(stream.text.includes('\ufffd')).toBe(false);
    }
    expect(output.stdout.text).toContain('invalid final answer');
    expect(output.stdout.text).toContain('turn.completed');
    expect(output.stderr.text).toContain('diagnostic end');
  });

  it('does not attach failure diagnostics to a valid answer', async () => {
    const result = await runPreparedInputCall(options({ retainFailureOutput: true }));
    expect(result.status).toBe('completed');
    expect(result).not.toHaveProperty('failureOutput');
  });

  it('refuses an unsupported CLI version before starting a model call', async () => {
    const env = { ...options().env, FAKE_CODEX_VERSION: 'codex-cli 0.153.9' };
    const processes: Array<{ pid: number; processGroupId: number | null }> = [];
    const result = failed(
      await runPreparedInputCall(
        options({ env, onProviderProcess: (process) => processes.push(process) })
      )
    );

    expect(result.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.providerStarted).toBe(false);
    expect(result.message).toMatch(/require codex-cli 0\.154\.0/);
    expect(existsSync(preflightMarker)).toBe(true);
    expect(existsSync(modelMarker)).toBe(false);
    expect(processes).toEqual([]);
  });

  it('keeps strict Codex calls refused without even running the preflight', async () => {
    const result = failed(await runPreparedInputCall(options({ toolAccess: 'none' })));

    expect(result.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.refusals.map((refusal) => refusal.capability)).toEqual(['no_tool_execution']);
    expect(existsSync(preflightMarker)).toBe(false);
    expect(existsSync(modelMarker)).toBe(false);
  });

  it('cancels and confirms termination of the compatibility preflight', async () => {
    const controller = new AbortController();
    const env = { ...options().env, FAKE_CODEX_VERSION_BEHAVIOR: 'sleep' };
    const processes: Array<{ pid: number; processGroupId: number | null }> = [];
    const call = runPreparedInputCall(
      options({
        env,
        signal: controller.signal,
        onProviderProcess: (process) => processes.push(process),
      })
    );
    await waitForFile(preflightMarker);
    controller.abort();

    const result = failed(await call);
    expect(result).toMatchObject({
      code: 'CANCELLED',
      providerStarted: false,
      terminationConfirmed: true,
    });
    expect(processes).toEqual([]);
    expect(existsSync(modelMarker)).toBe(false);
  });

  it('refuses an unknown runtime policy without running the provider', async () => {
    const result = failed(
      await runPreparedInputCall(options({ toolAccess: 'read_only' as never }))
    );

    expect(result.code).toBe('INVALID_REQUEST');
    expect(existsSync(preflightMarker)).toBe(false);
    expect(existsSync(modelMarker)).toBe(false);
  });

  it.each(['AGENTS.override.md', 'AGENTS.md'])(
    'does not reject or change a global %s',
    async (name) => {
      const instructionPath = path.join(codexHome, name);
      const canary = 'do not read or change this canary';
      await writeFile(instructionPath, canary);

      const result = await runPreparedInputCall(options());

      expect(result.status).toBe('completed');
      expect(await readFile(instructionPath, 'utf8')).toBe(canary);
      expect(existsSync(preflightMarker)).toBe(true);
      expect(existsSync(modelMarker)).toBe(true);
    }
  );
});
