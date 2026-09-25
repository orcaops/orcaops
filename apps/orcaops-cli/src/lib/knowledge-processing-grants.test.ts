import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { grantsFilePath, readGrants, writeGrant } from './evaluator-grants.js';
import { evaluateProcessingConsent } from './knowledge-processing-consent.js';
import {
  InteractiveConsentConfirmation,
  listProcessingGrants,
  PROCESSING_GRANTS_FILE_NAME,
  processingGrantsFilePath,
  type ProcessingGrantTerms,
  readProcessingGrants,
  recordProcessingGrant,
  revokeProcessingGrants,
} from './knowledge-processing-grants.js';
import { ErrorCodes } from '../io/errors.js';

vi.mock('node:tty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:tty')>()),
  isatty: vi.fn(),
}));

let configDir: string;
let repoRoot: string;

beforeEach(async () => {
  vi.mocked(isatty).mockReturnValue(true);
  configDir = await mkdtemp(path.join(tmpdir(), 'orcaops-processing-grants-'));
  repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-processing-repo-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const TERMS: ProcessingGrantTerms = {
  project_id: 'project-a',
  provider: 'claude',
  processor_contract: 'knowledge-processor/1',
  source_scope: { admitted_after_sequence: 40, backlog: 'excluded' },
  disclosed: {
    tool_access: 'none',
    model: { selection: 'explicit', id: 'model-under-test' },
    limits: {
      max_cost_usd_per_call: { usd: 0.5, holds: 'best_effort' },
      max_cost_usd_per_day: 'none',
      max_calls_per_hour: 60,
      max_input_bytes: 131_072,
      max_output_bytes: 65_536,
    },
    paused_backlog_count: 0,
  },
};

const EVALUATOR_GRANT = {
  kind: 'fingerprint' as const,
  package_id: 'core',
  source_fingerprint: 'a'.repeat(64),
  capabilities: [
    'command_evaluators_present' as const,
    'llm_evaluators_present' as const,
    'file_reading_llm_evaluator_present' as const,
  ],
  granted_at: '2026-01-01T00:00:00.000Z',
};

function accepted(terms: ProcessingGrantTerms = TERMS): InteractiveConsentConfirmation {
  return InteractiveConsentConfirmation.forTermsAcceptedAtTerminal(terms);
}

async function record(changes: Partial<ProcessingGrantTerms> = {}, now?: Date) {
  const terms = { ...TERMS, ...changes };
  return recordProcessingGrant(terms, {
    configDir,
    repoRoot,
    interactiveConfirmation: accepted(terms),
    ...(now !== undefined ? { now } : {}),
  });
}

function decide(job: { admitted_sequence: number }, provider: 'claude' | 'codex' = 'claude') {
  return evaluateProcessingConsent({
    ...readProcessingGrants({ configDir, repoRoot }),
    project_id: TERMS.project_id,
    provider,
    processor_contract: TERMS.processor_contract,
    effective_tool_access: TERMS.disclosed.tool_access,
    effective_limits: TERMS.disclosed.limits,
    job,
  });
}

async function plantStoreFile(contents: string, mode = 0o600): Promise<string> {
  const file = processingGrantsFilePath(configDir);
  await writeFile(file, contents, { mode });
  return file;
}

function waitForChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`child exited with code ${child.exitCode}`));
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited with code ${String(code)} signal ${String(signal)}`));
    });
  });
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('processing grant store', () => {
  it('reads nothing from an absent store and creates nothing', async () => {
    const absent = path.join(configDir, 'never-created');
    expect(readProcessingGrants({ configDir: absent, repoRoot })).toEqual({
      grants: [],
      problems: [],
    });
    expect(existsSync(absent)).toBe(false);
  });

  it('records a grant bound to exactly the terms it was given', async () => {
    const { grant, superseded_grant_ids } = await record({}, new Date('2026-03-01T12:00:00.000Z'));

    expect(superseded_grant_ids).toEqual([]);
    expect(grant).toEqual({
      grant_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      capability: 'capture_content_llm_processing',
      project_id: TERMS.project_id,
      provider: 'claude',
      processor_contract: TERMS.processor_contract,
      source_scope: TERMS.source_scope,
      disclosed: { provider: 'claude', ...TERMS.disclosed },
      granted_at: '2026-03-01T12:00:00.000Z',
    });
    expect(JSON.parse(await readFile(processingGrantsFilePath(configDir), 'utf8'))).toEqual({
      v: 1,
      grants: [grant],
    });
    expect(readProcessingGrants({ configDir, repoRoot })).toEqual({
      grants: [grant],
      problems: [],
    });
    expect(decide({ admitted_sequence: 41 })).toEqual({ ok: true, grant_id: grant.grant_id });
    expect(decide({ admitted_sequence: 40 })).toMatchObject({
      ok: false,
      reason: 'backlog_not_included',
    });
  });

  it.skipIf(process.platform === 'win32')('creates the store private', async () => {
    const fresh = path.join(configDir, 'fresh-home');
    await recordProcessingGrant(TERMS, {
      configDir: fresh,
      repoRoot,
      interactiveConfirmation: accepted(),
    });
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(statSync(processingGrantsFilePath(fresh)).mode & 0o777).toBe(0o600);
    expect(readdirSync(fresh).filter((entry) => entry.includes('.tmp.'))).toEqual([]);
  });

  it('keeps its file beside the evaluator grants and separate from them', async () => {
    await writeGrant(EVALUATOR_GRANT, { configDir, repoRoot });
    const evaluatorBytes = await readFile(grantsFilePath(configDir));

    await record();
    expect(path.dirname(processingGrantsFilePath(configDir))).toBe(
      path.dirname(grantsFilePath(configDir))
    );
    expect(PROCESSING_GRANTS_FILE_NAME).not.toBe(path.basename(grantsFilePath(configDir)));
    expect(await readFile(grantsFilePath(configDir))).toEqual(evaluatorBytes);

    const processingBytes = await readFile(processingGrantsFilePath(configDir));
    await writeGrant({ ...EVALUATOR_GRANT, package_id: 'second-pack' }, { configDir, repoRoot });
    await revokeProcessingGrants({ project_id: 'project-without-grants' }, { configDir, repoRoot });
    expect(await readFile(processingGrantsFilePath(configDir))).toEqual(processingBytes);
    expect(readGrants({ configDir, repoRoot }).grants).toHaveLength(2);
  });

  it('finds no processing consent in a config home full of evaluator grants', async () => {
    await writeGrant(EVALUATOR_GRANT, { configDir, repoRoot });
    await writeGrant(
      {
        kind: 'workspace-dev',
        package_id: TERMS.project_id,
        resolved_path: repoRoot,
        capabilities: ['llm_evaluators_present', 'file_reading_llm_evaluator_present'],
        granted_at: '2026-01-01T00:00:00.000Z',
      },
      { configDir, repoRoot }
    );

    expect(readProcessingGrants({ configDir, repoRoot })).toEqual({ grants: [], problems: [] });
    expect(decide({ admitted_sequence: 41 })).toMatchObject({ ok: false, reason: 'no_grant' });
  });

  it('refuses evaluator grants planted in the processing grant file', async () => {
    await plantStoreFile(`${JSON.stringify({ v: 1, grants: [EVALUATOR_GRANT] })}\n`);

    expect(readProcessingGrants({ configDir, repoRoot })).toMatchObject({
      grants: [],
      problems: [{ code: 'grant_file_invalid' }],
    });
    expect(decide({ admitted_sequence: 41 })).toMatchObject({
      ok: false,
      code: 'CONSENT_DENIED',
      reason: 'store_unreadable_or_unsafe',
    });
  });
});

describe('processing grant store fails closed', () => {
  it('yields no grants for unparseable JSON, another version, an unknown field or capability', async () => {
    const { grant } = await record();
    const cases: [string, string][] = [
      ['{not json', 'grant_file_unparseable'],
      [JSON.stringify({ v: 2, grants: [grant] }), 'grant_file_invalid'],
      [JSON.stringify({ v: 1, grants: [grant], minted_by: 'repo' }), 'grant_file_invalid'],
      [JSON.stringify({ v: 1, grants: [{ ...grant, note: 'extra' }] }), 'grant_file_invalid'],
      [
        JSON.stringify({ v: 1, grants: [{ ...grant, capability: 'llm_evaluators_present' }] }),
        'grant_file_invalid',
      ],
    ];
    for (const [contents, code] of cases) {
      await plantStoreFile(contents);
      expect(readProcessingGrants({ configDir, repoRoot })).toMatchObject({
        grants: [],
        problems: [{ code, message: expect.stringMatching(/aside/) }],
      });
    }
  });

  it('yields no grants from a file that repeats a grant id', async () => {
    const { grant } = await record();
    await plantStoreFile(
      JSON.stringify({ v: 1, grants: [grant, { ...grant, project_id: 'project-b' }] })
    );
    expect(readProcessingGrants({ configDir, repoRoot })).toMatchObject({
      grants: [],
      problems: [{ code: 'grant_file_invalid' }],
    });
  });

  it('refuses to change a grant file it cannot read, leaving its bytes alone', async () => {
    const file = await plantStoreFile('{"v":2,"grants":[]}');

    await expect(record()).rejects.toMatchObject({
      code: ErrorCodes.INVALID_INPUT,
      message: expect.stringMatching(/refusing to change knowledge processing grants/),
    });
    await expect(
      revokeProcessingGrants({ project_id: TERMS.project_id }, { configDir, repoRoot })
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_INPUT });
    expect(await readFile(file, 'utf8')).toBe('{"v":2,"grants":[]}');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked grant file instead of following it',
    async () => {
      const { grant } = await record();
      const planted = path.join(repoRoot, 'planted-grants.json');
      await writeFile(planted, `${JSON.stringify({ v: 1, grants: [grant] })}\n`, { mode: 0o600 });
      await rm(processingGrantsFilePath(configDir));
      await symlink(planted, processingGrantsFilePath(configDir));

      expect(readProcessingGrants({ configDir, repoRoot })).toEqual({
        grants: [],
        problems: [
          { code: 'store_unsafe', message: expect.stringContaining('is not a regular file') },
        ],
      });
      await expect(record()).rejects.toThrow(/is not a regular file/);
      expect(JSON.parse(await readFile(planted, 'utf8')).grants).toEqual([grant]);
    }
  );

  it.skipIf(process.platform === 'win32' || typeof process.getuid !== 'function')(
    'refuses a store owned by another user',
    async () => {
      await record();
      const bytes = await readFile(processingGrantsFilePath(configDir));
      const ownerUid = statSync(configDir).uid;
      vi.spyOn(process, 'getuid').mockReturnValue(ownerUid + 1);

      const result = readProcessingGrants({ configDir, repoRoot });
      expect(result.grants).toEqual([]);
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.problems.every((problem) => problem.code === 'store_unsafe')).toBe(true);
      expect(result.problems[0]?.message).toMatch(/is owned by uid/);
      await expect(record({ project_id: 'project-b' })).rejects.toThrow(/owned by uid/);
      expect(await readFile(processingGrantsFilePath(configDir))).toEqual(bytes);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'never repairs or trusts a store other users can read, and says how to fix it',
    async () => {
      await record();
      chmodSync(configDir, 0o755);
      chmodSync(processingGrantsFilePath(configDir), 0o644);

      const read = readProcessingGrants({ configDir, repoRoot });
      expect(read.grants).toEqual([]);
      expect(read.problems).toEqual([
        { code: 'store_permissions_widened', message: expect.stringContaining('chmod 700') },
        { code: 'store_permissions_widened', message: expect.stringContaining('chmod 600') },
      ]);
      expect(listProcessingGrants({ configDir, repoRoot })).toEqual({
        entries: [],
        problems: read.problems,
      });
      expect(decide({ admitted_sequence: 41 })).toMatchObject({
        ok: false,
        reason: 'store_unreadable_or_unsafe',
      });
      expect(statSync(configDir).mode & 0o777).toBe(0o755);
      expect(statSync(processingGrantsFilePath(configDir)).mode & 0o777).toBe(0o644);

      chmodSync(configDir, 0o700);
      expect(readProcessingGrants({ configDir, repoRoot }).problems).toEqual([
        { code: 'store_permissions_widened', message: expect.stringContaining('chmod 600') },
      ]);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'never trusts a grant file other users can write, even after its mode is fixed by hand',
    async () => {
      await record();
      for (const mode of [0o620, 0o602, 0o666]) {
        chmodSync(processingGrantsFilePath(configDir), mode);
        expect(readProcessingGrants({ configDir, repoRoot })).toEqual({
          grants: [],
          problems: [
            { code: 'store_writable_by_others', message: expect.stringMatching(/Move it aside/) },
          ],
        });
        expect(statSync(processingGrantsFilePath(configDir)).mode & 0o777).toBe(mode);
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'tightens a store other users could only read when a grant changes',
    async () => {
      const first = await record();
      chmodSync(configDir, 0o755);
      chmodSync(processingGrantsFilePath(configDir), 0o644);

      const second = await record({ project_id: 'project-b' });

      expect(statSync(configDir).mode & 0o777).toBe(0o700);
      expect(statSync(processingGrantsFilePath(configDir)).mode & 0o777).toBe(0o600);
      expect(readProcessingGrants({ configDir, repoRoot })).toEqual({
        grants: [first.grant, second.grant],
        problems: [],
      });

      chmodSync(processingGrantsFilePath(configDir), 0o640);
      await revokeProcessingGrants({ project_id: 'project-b' }, { configDir, repoRoot });
      expect(statSync(processingGrantsFilePath(configDir)).mode & 0o777).toBe(0o600);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'refuses to change a grant file other users could have written',
    async () => {
      await record();
      const file = processingGrantsFilePath(configDir);
      const bytes = await readFile(file);
      chmodSync(file, 0o666);

      const refusal = {
        code: ErrorCodes.INVALID_INPUT,
        message: expect.stringMatching(/refusing to change .*Move it aside/s),
      };
      await expect(record({ project_id: 'project-b' })).rejects.toMatchObject(refusal);
      await expect(
        revokeProcessingGrants({ project_id: TERMS.project_id }, { configDir, repoRoot })
      ).rejects.toMatchObject(refusal);
      expect(await readFile(file)).toEqual(bytes);
      expect(statSync(file).mode & 0o777).toBe(0o666);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'refuses to change anything in a directory other users can write, leaving the evidence',
    async () => {
      const fresh = path.join(configDir, 'fresh-home');
      await mkdir(fresh, { mode: 0o700 });
      chmodSync(fresh, 0o777);
      await expect(
        recordProcessingGrant(TERMS, {
          configDir: fresh,
          repoRoot,
          interactiveConfirmation: accepted(),
        })
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_INPUT,
        message: expect.stringMatching(/chmod 700 .* before granting consent/),
      });
      expect(existsSync(processingGrantsFilePath(fresh))).toBe(false);

      await record();
      const bytes = await readFile(processingGrantsFilePath(configDir));
      chmodSync(configDir, 0o770);
      await expect(record({ project_id: 'project-b' })).rejects.toMatchObject({
        code: ErrorCodes.INVALID_INPUT,
        message: expect.stringMatching(/chmod 700 .* aside/),
      });
      expect(readProcessingGrants({ configDir, repoRoot })).toMatchObject({
        grants: [],
        problems: [{ code: 'store_writable_by_others' }],
      });
      expect(statSync(configDir).mode & 0o777).toBe(0o770);
      expect(await readFile(processingGrantsFilePath(configDir))).toEqual(bytes);
    }
  );
});

describe('processing grant store containment', () => {
  it('refuses a config home inside the repository for changes and reads none from it', async () => {
    const { grant } = await record();
    const insideDir = path.join(repoRoot, '.orcaops-fake-home');
    const inside = { configDir: insideDir, repoRoot };

    await expect(
      recordProcessingGrant(TERMS, { ...inside, interactiveConfirmation: accepted() })
    ).rejects.toMatchObject({
      code: ErrorCodes.INVALID_INPUT,
      message: expect.stringMatching(/outside the repository/),
    });
    await expect(
      revokeProcessingGrants({ project_id: TERMS.project_id }, inside)
    ).rejects.toMatchObject({
      code: ErrorCodes.INVALID_INPUT,
      message: expect.stringMatching(/outside the repository/),
    });
    expect(existsSync(insideDir)).toBe(false);

    await mkdir(insideDir, { recursive: true, mode: 0o700 });
    await writeFile(
      processingGrantsFilePath(insideDir),
      `${JSON.stringify({ v: 1, grants: [grant] })}\n`,
      { mode: 0o600 }
    );
    if (process.platform !== 'win32') {
      chmodSync(insideDir, 0o755);
      chmodSync(processingGrantsFilePath(insideDir), 0o644);
    }
    expect(readProcessingGrants(inside)).toMatchObject({
      grants: [],
      problems: [{ code: 'store_not_outside_repository' }],
    });
    if (process.platform !== 'win32') {
      expect(statSync(insideDir).mode & 0o777).toBe(0o755);
      expect(statSync(processingGrantsFilePath(insideDir)).mode & 0o777).toBe(0o644);
    }
  });

  it('refuses a symlinked spelling of a store inside the repository', async () => {
    const realStore = path.join(repoRoot, '.orcaops-store');
    await mkdir(realStore, { recursive: true });
    const linked = path.join(configDir, 'alias');
    await symlink(realStore, linked);

    await expect(
      recordProcessingGrant(TERMS, {
        configDir: linked,
        repoRoot,
        interactiveConfirmation: accepted(),
      })
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_INPUT });
    expect(readProcessingGrants({ configDir: linked, repoRoot }).problems).toMatchObject([
      { code: 'store_not_outside_repository' },
    ]);
    expect(existsSync(processingGrantsFilePath(realStore))).toBe(false);
  });

  it('refuses a relative config home and an invalid repository root', async () => {
    expect(readProcessingGrants({ configDir: '.orcaops', repoRoot }).problems).toMatchObject([
      { code: 'store_not_outside_repository' },
    ]);
    for (const invalidRoot of ['', 'relative-root', path.join(repoRoot, 'missing')]) {
      expect(readProcessingGrants({ configDir, repoRoot: invalidRoot }).problems).toMatchObject([
        { code: 'repository_root_invalid' },
      ]);
      await expect(
        recordProcessingGrant(TERMS, {
          configDir,
          repoRoot: invalidRoot,
          interactiveConfirmation: accepted(),
        })
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_INPUT,
        message: expect.stringMatching(/repository root/),
      });
    }
    expect(existsSync(processingGrantsFilePath(configDir))).toBe(false);
  });
});

function changedLimit(
  value: ProcessingGrantTerms['disclosed']['limits'][keyof ProcessingGrantTerms['disclosed']['limits']]
) {
  if (value === 'none') return 1;
  return typeof value === 'number' ? value + 1 : { ...value, usd: value.usd + 1 };
}

describe('recording consent', () => {
  it('builds a confirmation only when this process has a terminal on both ends', () => {
    for (const [input, output] of [
      [false, true],
      [true, false],
      [false, false],
    ]) {
      vi.mocked(isatty).mockImplementation((fd) => (fd === 0 ? input === true : output === true));
      expect(() => InteractiveConsentConfirmation.forTermsAcceptedAtTerminal(TERMS)).toThrow(
        /interactive terminal/
      );
    }
    expect(vi.mocked(isatty).mock.calls.every(([fd]) => fd === 0 || fd === 1)).toBe(true);

    expect(() =>
      InteractiveConsentConfirmation.forTermsAcceptedAtTerminal({
        ...TERMS,
        // @ts-expect-error the caller cannot vouch for a stream being a terminal
        input: { isTTY: true },
        output: { isTTY: true },
      })
    ).toThrow(/interactive terminal/);
  });

  it('cannot be constructed around the terminal check', () => {
    const Confirmation = InteractiveConsentConfirmation as unknown as new (
      ...args: unknown[]
    ) => object;
    const lookalikeToken = Symbol('interactive consent confirmation');
    class Subclass extends Confirmation {}

    // @ts-expect-error the constructor is private
    expect(() => new InteractiveConsentConfirmation(lookalikeToken, TERMS)).toThrow(
      /forTermsAcceptedAtTerminal/
    );
    expect(() => new Confirmation()).toThrow(/forTermsAcceptedAtTerminal/);
    expect(() => Reflect.construct(Confirmation, [lookalikeToken, TERMS])).toThrow(
      /forTermsAcceptedAtTerminal/
    );
    expect(() => new Subclass(lookalikeToken, TERMS)).toThrow(/forTermsAcceptedAtTerminal/);
  });

  it('refuses anything that is not a confirmation', async () => {
    const yesFlag = true;
    for (const notAConfirmation of [
      yesFlag,
      { confirmedTerms: TERMS, spent: false },
      Object.create(InteractiveConsentConfirmation.prototype) as unknown,
      undefined,
    ]) {
      await expect(
        recordProcessingGrant(TERMS, {
          configDir,
          repoRoot,
          // @ts-expect-error a flag value or look-alike object is not a confirmation
          interactiveConfirmation: notAConfirmation,
        })
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_INPUT,
        message: expect.stringMatching(/without an interactive confirmation/),
      });
    }
    expect(existsSync(processingGrantsFilePath(configDir))).toBe(false);
  });

  it('records only the exact terms the person confirmed', async () => {
    const limits = TERMS.disclosed.limits;
    const changed: [string, ProcessingGrantTerms][] = [
      ['project_id', { ...TERMS, project_id: 'project-b' }],
      ['provider', { ...TERMS, provider: 'codex' }],
      ['processor_contract', { ...TERMS, processor_contract: 'knowledge-processor/2' }],
      ['source_scope', { ...TERMS, source_scope: { ...TERMS.source_scope, backlog: 'included' } }],
      [
        'source_scope',
        { ...TERMS, source_scope: { ...TERMS.source_scope, admitted_after_sequence: 0 } },
      ],
      [
        'disclosed',
        { ...TERMS, disclosed: { ...TERMS.disclosed, model: { selection: 'provider_default' } } },
      ],
      ['disclosed', { ...TERMS, disclosed: { ...TERMS.disclosed, paused_backlog_count: 9 } }],
      ...(Object.keys(limits) as (keyof typeof limits)[]).map(
        (name): [string, ProcessingGrantTerms] => [
          'disclosed',
          {
            ...TERMS,
            disclosed: {
              ...TERMS.disclosed,
              limits: { ...limits, [name]: changedLimit(limits[name]) },
            },
          },
        ]
      ),
    ];
    for (const [field, terms] of changed) {
      await expect(
        recordProcessingGrant(terms, {
          configDir,
          repoRoot,
          interactiveConfirmation: accepted(TERMS),
        })
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_INPUT,
        message: expect.stringMatching(new RegExp(`${field} differ from the terms`)),
      });
    }
    expect(existsSync(processingGrantsFilePath(configDir))).toBe(false);
  });

  it('matches confirmed terms whatever order their keys arrive in', async () => {
    const reordered = {
      disclosed: {
        paused_backlog_count: TERMS.disclosed.paused_backlog_count,
        limits: Object.fromEntries(Object.entries(TERMS.disclosed.limits).reverse()),
        model: TERMS.disclosed.model,
        tool_access: TERMS.disclosed.tool_access,
      },
      source_scope: { backlog: 'excluded', admitted_after_sequence: 40 },
      processor_contract: TERMS.processor_contract,
      provider: TERMS.provider,
      project_id: TERMS.project_id,
    } as ProcessingGrantTerms;

    const { grant } = await recordProcessingGrant(reordered, {
      configDir,
      repoRoot,
      interactiveConfirmation: accepted(TERMS),
    });
    expect(grant.disclosed).toEqual({ provider: 'claude', ...TERMS.disclosed });
  });

  it('spends a confirmation on its first use, whether or not a grant resulted', async () => {
    const confirmation = accepted(TERMS);
    const opts = { configDir, repoRoot, interactiveConfirmation: confirmation };
    await recordProcessingGrant(TERMS, opts);
    await expect(recordProcessingGrant(TERMS, opts)).rejects.toMatchObject({
      code: ErrorCodes.INVALID_INPUT,
      message: expect.stringMatching(/already used/),
    });
    expect(readProcessingGrants({ configDir, repoRoot }).grants).toHaveLength(1);

    const misused = { configDir, repoRoot, interactiveConfirmation: accepted(TERMS) };
    await expect(
      recordProcessingGrant({ ...TERMS, project_id: 'project-b' }, misused)
    ).rejects.toThrow(/differ from the terms/);
    await expect(recordProcessingGrant(TERMS, misused)).rejects.toThrow(/already used/);
    expect(readProcessingGrants({ configDir, repoRoot }).grants).toHaveLength(1);
  });

  it('never defaults the backlog choice', async () => {
    await expect(
      record({
        // @ts-expect-error the backlog choice is required
        source_scope: { admitted_after_sequence: 40 },
      })
    ).rejects.toMatchObject({
      code: ErrorCodes.INVALID_INPUT,
      message: expect.stringMatching(/source_scope\.backlog/),
    });
    expect(existsSync(processingGrantsFilePath(configDir))).toBe(false);

    const { grant } = await record({
      source_scope: { admitted_after_sequence: 40, backlog: 'included' },
    });
    expect(decide({ admitted_sequence: 7 })).toEqual({ ok: true, grant_id: grant.grant_id });
  });

  it('revokes the earlier grant for the same binding when a new one is recorded', async () => {
    const wider = await record({
      source_scope: { admitted_after_sequence: 10, backlog: 'included' },
    });
    const otherProvider = await record({ provider: 'codex' });
    const otherToolAccess = await record({
      provider: 'codex',
      disclosed: { ...TERMS.disclosed, tool_access: 'codex_restricted' },
    });
    const otherContract = await record({ processor_contract: 'knowledge-processor/2' });
    const otherProject = await record({ project_id: 'project-b' });

    const narrower = await record({}, new Date('2026-04-01T00:00:00.000Z'));

    expect(narrower.superseded_grant_ids).toEqual([wider.grant.grant_id]);
    expect(readProcessingGrants({ configDir, repoRoot }).grants).toEqual([
      { ...wider.grant, revoked_at: '2026-04-01T00:00:00.000Z' },
      otherProvider.grant,
      otherToolAccess.grant,
      otherContract.grant,
      otherProject.grant,
      narrower.grant,
    ]);
    expect(decide({ admitted_sequence: 20 })).toMatchObject({
      ok: false,
      reason: 'backlog_not_included',
    });
    expect(decide({ admitted_sequence: 41 })).toEqual({
      ok: true,
      grant_id: narrower.grant.grant_id,
    });
  });

  it('records nothing when the paired change fails', async () => {
    const fresh = path.join(configDir, 'fresh-home');
    const failing = () => ({
      repoRoot,
      interactiveConfirmation: accepted(),
      pairedCommit: async () => {
        throw new Error('configuration write failed');
      },
    });
    await expect(recordProcessingGrant(TERMS, { ...failing(), configDir: fresh })).rejects.toThrow(
      'configuration write failed'
    );
    expect(existsSync(processingGrantsFilePath(fresh))).toBe(false);

    await record();
    const bytes = await readFile(processingGrantsFilePath(configDir));
    await expect(recordProcessingGrant(TERMS, { ...failing(), configDir })).rejects.toThrow(
      'configuration write failed'
    );
    expect(await readFile(processingGrantsFilePath(configDir))).toEqual(bytes);
  });

  it('hands the recorded grant to the paired change', async () => {
    const seen: string[] = [];
    const { grant } = await recordProcessingGrant(TERMS, {
      configDir,
      repoRoot,
      interactiveConfirmation: accepted(),
      pairedCommit: async (recorded) => {
        seen.push(recorded.grant_id);
      },
    });
    expect(seen).toEqual([grant.grant_id]);
  });
});

describe('revoking consent', () => {
  it('marks grants revoked instead of deleting them, and the decision then denies', async () => {
    const { grant } = await record();

    await expect(
      revokeProcessingGrants(
        { project_id: TERMS.project_id },
        { configDir, repoRoot, now: new Date('2026-05-01T00:00:00.000Z') }
      )
    ).resolves.toEqual({ revoked_grant_ids: [grant.grant_id] });

    expect(readProcessingGrants({ configDir, repoRoot }).grants).toEqual([
      { ...grant, revoked_at: '2026-05-01T00:00:00.000Z' },
    ]);
    expect(decide({ admitted_sequence: 41 })).toMatchObject({
      ok: false,
      code: 'CONSENT_DENIED',
      reason: 'revoked',
    });
    expect(listProcessingGrants({ configDir, repoRoot }).entries).toEqual([
      { grant: { ...grant, revoked_at: '2026-05-01T00:00:00.000Z' }, in_force: false },
    ]);
  });

  it('revokes every provider of the project unless narrowed, and no other project', async () => {
    const claude = await record();
    const codex = await record({ provider: 'codex' });
    const otherProject = await record({ project_id: 'project-b' });

    await expect(
      revokeProcessingGrants(
        { project_id: TERMS.project_id, provider: 'codex' },
        { configDir, repoRoot }
      )
    ).resolves.toEqual({ revoked_grant_ids: [codex.grant.grant_id] });
    expect(decide({ admitted_sequence: 41 })).toMatchObject({ ok: true });
    expect(decide({ admitted_sequence: 41 }, 'codex')).toMatchObject({
      ok: false,
      reason: 'revoked',
    });

    await expect(
      revokeProcessingGrants({ project_id: TERMS.project_id }, { configDir, repoRoot })
    ).resolves.toEqual({ revoked_grant_ids: [claude.grant.grant_id] });
    expect(
      listProcessingGrants({ configDir, repoRoot })
        .entries.filter((entry) => entry.in_force)
        .map((entry) => entry.grant.grant_id)
    ).toEqual([otherProject.grant.grant_id]);
  });

  it('changes nothing when there is nothing left to revoke', async () => {
    await record();
    await revokeProcessingGrants({ project_id: TERMS.project_id }, { configDir, repoRoot });
    const bytes = await readFile(processingGrantsFilePath(configDir));

    await expect(
      revokeProcessingGrants({ project_id: TERMS.project_id }, { configDir, repoRoot })
    ).resolves.toEqual({ revoked_grant_ids: [] });
    expect(await readFile(processingGrantsFilePath(configDir))).toEqual(bytes);
  });

  it('needs a new grant after revocation, which leaves the revoked one on record', async () => {
    const first = await record();
    await revokeProcessingGrants({ project_id: TERMS.project_id }, { configDir, repoRoot });
    const second = await record();

    expect(second.superseded_grant_ids).toEqual([]);
    expect(decide({ admitted_sequence: 41 })).toEqual({
      ok: true,
      grant_id: second.grant.grant_id,
    });
    expect(
      readProcessingGrants({ configDir, repoRoot }).grants.map((grant) => grant.grant_id)
    ).toEqual([first.grant.grant_id, second.grant.grant_id]);
  });
});

describe('concurrent grant changes', () => {
  it('keeps every grant recorded concurrently in one process', async () => {
    const projects = Array.from({ length: 8 }, (_, index) => `project-${index}`);
    await Promise.all(projects.map((project_id) => record({ project_id })));

    expect(
      readProcessingGrants({ configDir, repoRoot })
        .grants.map((grant) => grant.project_id)
        .sort()
    ).toEqual(projects);
  });

  it('loses neither a grant nor a revocation to a change made by another process', async () => {
    const storeDist = path.join(
      REPO_ROOT,
      'apps/orcaops-cli/dist/lib/knowledge-processing-grants.js'
    );
    expect(existsSync(storeDist), 'build @orcaops/cli before this cross-process proof').toBe(true);

    const revokerScript = path.join(repoRoot, 'processing-grant-revoker.mjs');
    await writeFile(
      revokerScript,
      [
        'const [storeDist, configDir, repoRoot, projectId] = process.argv.slice(2);',
        'const { revokeProcessingGrants } = await import(storeDist);',
        'await revokeProcessingGrants({ project_id: projectId }, { configDir, repoRoot });',
      ].join('\n'),
      'utf8'
    );

    const revokedProjects = ['project-x', 'project-y', 'project-z'];
    for (const project_id of revokedProjects) await record({ project_id });
    const recordedProjects = ['project-p', 'project-q', 'project-r'];

    const revokers = revokedProjects.map((projectId) =>
      spawn(process.execPath, [revokerScript, storeDist, configDir, repoRoot, projectId])
    );
    try {
      await Promise.all([
        ...revokers.map(waitForChild),
        ...recordedProjects.map((project_id) => record({ project_id })),
      ]);
    } finally {
      for (const revoker of revokers) if (revoker.exitCode === null) revoker.kill();
    }

    const inForce = (project_id: string) =>
      listProcessingGrants({ configDir, repoRoot }, { project_id }).entries.map(
        (entry) => entry.in_force
      );
    for (const project_id of revokedProjects) expect(inForce(project_id)).toEqual([false]);
    for (const project_id of recordedProjects) expect(inForce(project_id)).toEqual([true]);
  });

  it('waits behind the config store lock held by another process', async () => {
    const coreDist = path.join(REPO_ROOT, 'packages/core/dist/index.js');
    const storeDist = path.join(
      REPO_ROOT,
      'apps/orcaops-cli/dist/lib/knowledge-processing-grants.js'
    );
    expect(existsSync(coreDist), 'build @orcaops/core before this cross-process proof').toBe(true);
    expect(existsSync(storeDist), 'build @orcaops/cli before this cross-process proof').toBe(true);

    const ready = path.join(configDir, 'holder-ready');
    const release = path.join(configDir, 'holder-release');
    const holderScript = path.join(repoRoot, 'store-lock-holder.mjs');
    await writeFile(
      holderScript,
      [
        'const [coreDist, configDir, ready, release] = process.argv.slice(2);',
        'const { FileStore } = await import(coreDist);',
        'const { existsSync, writeFileSync } = await import("node:fs");',
        'const store = new FileStore({ dir: configDir });',
        'await store.withRefreshLock("holder", async () => {',
        '  writeFileSync(ready, "ready");',
        '  while (!existsSync(release)) await new Promise((r) => setTimeout(r, 10));',
        '});',
      ].join('\n'),
      'utf8'
    );

    const holder = spawn(process.execPath, [holderScript, coreDist, configDir, ready, release]);
    try {
      await waitForFile(ready);
      let recorded = false;
      const recording = record().then(() => {
        recorded = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(recorded).toBe(false);
      expect(existsSync(processingGrantsFilePath(configDir))).toBe(false);

      await writeFile(release, 'release', 'utf8');
      await Promise.all([waitForChild(holder), recording]);
      expect(readProcessingGrants({ configDir, repoRoot }).grants).toHaveLength(1);
    } finally {
      if (!existsSync(release)) await writeFile(release, 'release', 'utf8');
      if (holder.exitCode === null) holder.kill();
    }
  });
});
