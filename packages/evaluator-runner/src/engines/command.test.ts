import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type EvaluatorContext, type ResolvedEvaluator } from '@orcaops/evaluator-protocol';

import { runCommandEngine } from './command.js';

const RUN_ID = '01HXRUN0000000000000000000';

function makeContext(overrides: Partial<EvaluatorContext> = {}): EvaluatorContext {
  return {
    schema: 'orcaops.evaluator_context/v1',
    run_id: RUN_ID,
    evaluator_ref: 'core/test-eval',
    phase: 'post-plan',
    artifact_id: '01HXART0000000000000000000',
    checkpoint_n: null,
    repo: {
      root: '/tmp/orcaops-test-repo',
      branch: 'main',
      base_sha: 'sha-base',
      head_sha: 'sha-head',
    },
    plan: {
      task: 'test',
      label: 't',
      branch: 'main',
      base_sha: 'sha-base',
      agent: null,
      agent_session_id: null,
      plan_steps: [],
      touched_scope: [],
      non_goals: [],
      decisions: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      started_at: '2026-05-12T20:00:00.000Z',
    },
    prior_plan: null,
    source_plan: null,
    current_checkpoint: null,
    closed_checkpoints: [],
    open_checkpoints: [],
    abandoned_checkpoints: [],
    summary: null,
    changed_files: [],
    params: {},
    ...overrides,
  };
}

function makeResolved(overrides: {
  command: string[];
  cwd?: 'package' | 'repo';
  timeout_ms?: number;
  max_output_bytes?: number;
  env?: { inherit?: string[]; set?: Record<string, string> };
  output_schema?: Record<string, unknown>;
  package_root: string;
}): ResolvedEvaluator {
  return {
    ref: 'core/test-eval',
    package_id: 'core',
    evaluator_id: 'test-eval',
    package_root: overrides.package_root,
    spec_path: path.join(overrides.package_root, 'evaluators', 'test-eval.eval.yaml'),
    phase: 'post-plan',
    severity: 'warn',
    description: 'fixture evaluator',
    engine: {
      kind: 'command',
      command: overrides.command,
      cwd: overrides.cwd ?? 'package',
      timeout_ms: overrides.timeout_ms ?? 5000,
      max_output_bytes: overrides.max_output_bytes ?? 1024 * 1024,
      env: {
        inherit: overrides.env?.inherit ?? ['PATH'],
        set: overrides.env?.set ?? {},
      },
      ...(overrides.output_schema !== undefined ? { output_schema: overrides.output_schema } : {}),
    },
    params: {},
    filters: { paths: [], scopes: [], when_llm: 'optional' },
    resolution: { acknowledge: { enabled: false }, policy_exception: { enabled: false } },
    fingerprint_include: [],
    enabled: true,
  };
}

describe('runCommandEngine', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-cmd-test-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeScript(name: string, body: string): Promise<string> {
    const checksDir = path.join(tmpRoot, 'checks');
    await mkdir(checksDir, { recursive: true });
    const filePath = path.join(checksDir, name);
    await writeFile(filePath, `#!/bin/bash\n${body}\n`, 'utf8');
    await chmod(filePath, 0o755);
    return filePath;
  }

  it('completes successfully with a valid envelope on stdout', async () => {
    const script = await writeScript(
      'pass.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v2","verdict":"pass","body":"PASS\\n\\nnothing flagged"}
JSON`
    );
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('completed');
    expect(out.verdict).toBe('pass');
    expect(out.body).toMatch(/PASS/);
    expect(out.error).toBeUndefined();
    expect(out.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('hands over no findings when the envelope carries none', async () => {
    const script = await writeScript(
      'nofindings.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v2","verdict":"violation","body":"VIOLATION"}
JSON`
    );
    const out = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run.run_status).toBe('completed');
    expect(out.run.verdict).toBe('violation');
    expect(out.findings).toEqual({ status: 'none' });
  });

  it('treats an empty findings array as no findings', async () => {
    // A producer that computed none may say so either way; a record asserting
    // zero findings says nothing the absence of the record does not.
    const script = await writeScript(
      'emptyfindings.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v2","verdict":"pass","body":"PASS","findings":[]}
JSON`
    );
    const out = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run.run_status).toBe('completed');
    expect(out.findings).toEqual({ status: 'none' });
  });

  it('hands over the envelope findings and keeps them off the run payload', async () => {
    const script = await writeScript(
      'findings.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v2","verdict":"violation","body":"VIOLATION","findings":[{"key":"rule/no-todo","title":"src/a.ts still carries a TODO","detail":"line 4","locations":[{"kind":"file","path":"src/a.ts","start_line":4}]}]}
JSON`
    );
    const out = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run.run_status).toBe('completed');
    expect(out.run.verdict).toBe('violation');
    if (out.findings.status !== 'established') throw new Error('expected established findings');
    expect(out.findings.record).toEqual({
      schema: 'orcaops.evaluator_run_findings/v1',
      run_id: RUN_ID,
      findings: [
        {
          key: 'rule/no-todo',
          title: 'src/a.ts still carries a TODO',
          detail: 'line 4',
          locations: [{ kind: 'file', path: 'src/a.ts', start_line: 4 }],
        },
      ],
    });
    // The retained run shape does not change by one byte.
    expect(Object.hasOwn(out.run, 'findings')).toBe(false);
    expect(JSON.stringify(out.run)).not.toContain('still carries a TODO');
  });

  it('keeps the verdict when the findings cannot be read', async () => {
    // A conclusion with no expectation location is a shape failure. It costs
    // the findings and nothing else: the producer stated a violation and the
    // runner understood it.
    const script = await writeScript(
      'badfindings.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v2","verdict":"violation","body":"VIOLATION","findings":[{"title":"a statement","conclusion":"supported"}]}
JSON`
    );
    const out = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run.run_status).toBe('completed');
    expect(out.run.verdict).toBe('violation');
    expect(out.run.error).toBeUndefined();
    if (out.findings.status !== 'unreadable') throw new Error('expected unreadable findings');
    expect(out.findings.record.source).toBe('envelope');
    expect(out.findings.record.detail).toMatch(/conclusion/);
  });

  it('refuses a superseded envelope literal with the unsupported-protocol error', async () => {
    const script = await writeScript(
      'oldproducer.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v1","verdict":"pass","body":"PASS"}
JSON`
    );
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('error');
    expect(out.verdict).toBeNull();
    expect(out.error?.code).toBe('UNSUPPORTED_PROTOCOL');
    expect(out.error?.message).toContain('@orcaops/evaluator-sdk');
    expect(out.error?.message).toContain('orcaops.evaluator_result/v2');
  });

  it('refuses an unrecognised envelope literal with the unsupported-protocol error', async () => {
    const script = await writeScript(
      'strangeproducer.sh',
      `cat <<'JSON'
{"schema":"acme.result/v9","verdict":"pass","body":"PASS"}
JSON`
    );
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('UNSUPPORTED_PROTOCOL');
    expect(out.error?.message).toContain('acme.result/v9');
  });

  it('reports a missing schema literal as an invalid envelope, not a protocol failure', async () => {
    const script = await writeScript('undeclared.sh', `echo '{"verdict":"pass","body":"PASS"}'`);
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('ENVELOPE_INVALID');
    expect(out.error?.message).toContain('schema');
  });

  it('emits the orcaops env contract to the subprocess', async () => {
    const script = await writeScript(
      'envcheck.sh',
      `echo "{\\"schema\\":\\"orcaops.evaluator_result/v2\\",\\"verdict\\":\\"info\\",\\"body\\":\\"$ORCAOPS_RUN_ID:$ORCAOPS_PHASE:$ORCAOPS_ARTIFACT_ID:$ORCAOPS_EVALUATOR_REF\\"}"`
    );
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('completed');
    expect(out.body).toContain(RUN_ID);
    expect(out.body).toContain(':post-plan:');
    expect(out.body).toContain(':01HXART0000000000000000000:');
    expect(out.body).toContain(':core/test-eval');
  });

  it('exposes the context JSON via ORCAOPS_CONTEXT_PATH (temp-file delivery)', async () => {
    const script = await writeScript(
      'readctx.sh',
      `if [ -f "$ORCAOPS_CONTEXT_PATH" ]; then
  task=$(node -e "const d=require(process.env.ORCAOPS_CONTEXT_PATH); process.stdout.write(d.plan.task)")
  echo "{\\"schema\\":\\"orcaops.evaluator_result/v2\\",\\"verdict\\":\\"info\\",\\"body\\":\\"task=$task\\"}"
else
  echo "{\\"schema\\":\\"orcaops.evaluator_result/v2\\",\\"verdict\\":\\"violation\\",\\"body\\":\\"ORCAOPS_CONTEXT_PATH not set\\"}"
fi`
    );
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({
        command: [script],
        package_root: tmpRoot,
        env: { inherit: ['PATH'] },
      }),
      context: makeContext({
        plan: {
          task: 'fixture-task',
          label: 'fixture',
          branch: 'main',
          base_sha: 'sha-base',
          agent: null,
          agent_session_id: null,
          plan_steps: [],
          touched_scope: [],
          non_goals: [],
          decisions: [],
          revision_n: 0,
          revised_at: null,
          rationale: null,
          step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
          started_at: '2026-05-12T20:00:00.000Z',
        },
      }),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('completed');
    expect(out.body).toContain('task=fixture-task');
  });

  it('returns EXIT_CODE on non-zero exit', async () => {
    const script = await writeScript('fail.sh', `echo "boom" >&2\nexit 7`);
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('error');
    expect(out.verdict).toBeNull();
    expect(out.error?.code).toBe('EXIT_CODE');
    expect(out.body).toMatch(/STDERR:[\s\S]*boom/);
  });

  it('returns JSON_PARSE when stdout is not JSON', async () => {
    const script = await writeScript('junk.sh', `echo "not json {{{"`);
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('JSON_PARSE');
  });

  it('returns ENVELOPE_INVALID when stdout JSON is missing required envelope fields', async () => {
    const script = await writeScript('badenv.sh', `echo '{"foo":"bar"}'`);
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('ENVELOPE_INVALID');
  });

  it('returns TIMEOUT when the script outlives engine.timeout_ms', async () => {
    const script = await writeScript('slow.sh', `sleep 2`);
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({
        command: [script],
        package_root: tmpRoot,
        timeout_ms: 100,
      }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('TIMEOUT');
  });

  it('returns OUTPUT_TOO_LARGE when stdout exceeds max_output_bytes', async () => {
    const script = await writeScript('spew.sh', `head -c 1000000 /dev/urandom | base64`);
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({
        command: [script],
        package_root: tmpRoot,
        max_output_bytes: 1024,
      }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('OUTPUT_TOO_LARGE');
  });

  it('returns CANCELED when the AbortSignal fires', async () => {
    const script = await writeScript('wait.sh', `sleep 2`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({
        command: [script],
        package_root: tmpRoot,
        timeout_ms: 5000,
      }),
      context: makeContext(),
      run_id: RUN_ID,
      signal: controller.signal,
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('CANCELED');
  });

  it('returns SPAWN_ERROR when the command does not exist', async () => {
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({
        command: ['/this/path/does/not/exist-orcaops'],
        package_root: tmpRoot,
      }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('SPAWN_ERROR');
  });

  it('honors cwd=package by running in the pack root', async () => {
    const script = await writeScript(
      'pwd.sh',
      `pwd_out=$(pwd)
echo "{\\"schema\\":\\"orcaops.evaluator_result/v2\\",\\"verdict\\":\\"info\\",\\"body\\":\\"$pwd_out\\"}"`
    );
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({
        command: [script],
        package_root: tmpRoot,
        cwd: 'package',
      }),
      context: makeContext(),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('completed');
    // macOS resolves tmpdir to /private/tmp; match by trailing basename.
    expect(out.body).toMatch(new RegExp(`${path.basename(tmpRoot)}\\s*$`));
  });

  it('honors cwd=repo by running in context.repo.root', async () => {
    const repoRoot = path.join(tmpRoot, 'repo');
    await mkdir(repoRoot, { recursive: true });
    const script = await writeScript(
      'pwd-repo.sh',
      `pwd_out=$(pwd)
echo "{\\"schema\\":\\"orcaops.evaluator_result/v2\\",\\"verdict\\":\\"info\\",\\"body\\":\\"$pwd_out\\"}"`
    );
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({
        command: [script],
        package_root: tmpRoot,
        cwd: 'repo',
      }),
      context: makeContext({
        repo: { root: repoRoot, branch: 'main', base_sha: 'sha', head_sha: 'sha' },
      }),
      run_id: RUN_ID,
    });
    expect(out.run_status).toBe('completed');
    expect(out.body).toMatch(new RegExp(`${path.basename(repoRoot)}\\s*$`));
  });

  it('filters parent env via env.inherit allowlist', async () => {
    const script = await writeScript(
      'env.sh',
      `home_val="$HOME"
foo_val="\${FOO:-<unset>}"
echo "{\\"schema\\":\\"orcaops.evaluator_result/v2\\",\\"verdict\\":\\"info\\",\\"body\\":\\"HOME=$home_val FOO=$foo_val\\"}"`
    );
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({
        command: [script],
        package_root: tmpRoot,
        env: { inherit: ['PATH', 'HOME'] },
      }),
      context: makeContext(),
      run_id: RUN_ID,
      parentEnv: { HOME: '/test-home', FOO: 'should-not-pass', PATH: '/usr/bin:/bin' },
    });
    expect(out.run_status).toBe('completed');
    expect(out.body).toContain('HOME=/test-home');
    expect(out.body).toContain('FOO=<unset>');
  });

  it('forwards env.set values to the subprocess (overriding inherited values)', async () => {
    const script = await writeScript(
      'envset.sh',
      `echo "{\\"schema\\":\\"orcaops.evaluator_result/v2\\",\\"verdict\\":\\"info\\",\\"body\\":\\"HOME=$HOME CUSTOM=$CUSTOM\\"}"`
    );
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({
        command: [script],
        package_root: tmpRoot,
        env: {
          inherit: ['PATH', 'HOME'],
          set: { HOME: '/overridden', CUSTOM: 'set-value' },
        },
      }),
      context: makeContext(),
      run_id: RUN_ID,
      parentEnv: { HOME: '/parent-home', PATH: '/usr/bin:/bin' },
    });
    expect(out.run_status).toBe('completed');
    expect(out.body).toContain('HOME=/overridden');
    expect(out.body).toContain('CUSTOM=set-value');
  });

  it('invokes validateRaw and surfaces RAW_SCHEMA_INVALID on failure', async () => {
    const script = await writeScript(
      'withraw.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v2","verdict":"violation","body":"VIOLATION","raw":{"count":"not-a-number"}}
JSON`
    );
    const calls: Array<{ raw: unknown; schema: unknown }> = [];
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({
        command: [script],
        package_root: tmpRoot,
        output_schema: { type: 'object', properties: { count: { type: 'number' } } },
      }),
      context: makeContext(),
      run_id: RUN_ID,
      validateRaw: (raw, schema) => {
        calls.push({ raw, schema });
        const cast = raw as { count: unknown };
        if (typeof cast.count !== 'number') {
          throw new Error('count must be a number');
        }
      },
    });
    expect(calls).toHaveLength(1);
    expect(out.run_status).toBe('error');
    expect(out.error?.code).toBe('RAW_SCHEMA_INVALID');
    expect(out.error?.message).toMatch(/count must be a number/);
  });

  it('packs checkpoint_n onto the run when the context has one', async () => {
    const script = await writeScript(
      'cp.sh',
      `cat <<'JSON'
{"schema":"orcaops.evaluator_result/v2","verdict":"pass","body":"PASS"}
JSON`
    );
    const { run: out } = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext({ phase: 'checkpoint-close', checkpoint_n: 3 }),
      run_id: RUN_ID,
    });
    expect(out.checkpoint_n).toBe(3);
    expect(out.phase).toBe('checkpoint-close');
  });

  it('does not persist a secret an evaluator printed before failing', async () => {
    // The error body is written into the artifact and shown to reviewers,
    // and it folds in RAW evaluator stdout/stderr — a stack trace, an env
    // dump, an upstream error body. A secret quoted there used to land
    // verbatim and stay there.
    const secret = 'ghp_0000000000000000000000000000000000000';
    const split = `${secret.slice(0, 20)}\\033${secret.slice(20)}`;
    const script = await writeScript(
      'leaky.sh',
      `printf 'boom: ${split}\\n' >&2\nprintf 'not json: ${split}\\n'\nexit 3`
    );

    const { run: run } = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: 'run-leaky',
    });

    expect(run.run_status).toBe('error');
    expect(run.body).not.toContain(secret);
    expect(run.body).toContain('STDERR:\nboom: [REDACTED_SECRET]');
    expect(run.body).toContain('STDOUT (last 256 chars):\nnot json: [REDACTED_SECRET]');
    // Nothing anywhere in the persisted payload.
    expect(JSON.stringify(run)).not.toContain(secret);
  }, 20_000);

  it('redacts successful evaluator body and raw fields before persistence', async () => {
    const secret = 'ghp_0000000000000000000000000000000000000';
    const split = `${secret.slice(0, 20)}\\u001b${secret.slice(20)}`;
    const script = await writeScript(
      'leaky-pass.sh',
      `cat <<'JSON'\n{"schema":"orcaops.evaluator_result/v2","verdict":"pass","body":"PASS\\n\\n${split}","raw":{"detail":"${split}","${split}":"value"},"metrics":{"${split}":1}}\nJSON`
    );

    const { run: run } = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: 'run-leaky-pass',
    });

    expect(run.run_status).toBe('completed');
    expect(JSON.stringify(run)).not.toContain(secret);
    expect(run.body).toContain('REDACTED');
    expect(run.raw).toEqual({
      detail: '[REDACTED_SECRET]',
      '[REDACTED_SECRET]': 'value',
    });
    expect(run.metrics).toEqual({ '[REDACTED_SECRET]': 1 });
  });

  it('redacts a finding before bounding it, so a secret across the cut cannot survive', async () => {
    // The title is bounded at 500 characters and the secret straddles that
    // cut. Bounding first would sever it mid-token, leaving a prefix no
    // pattern matches and a secret in a retained record. Redacting first
    // shortens the title below the bound, so nothing is cut at all.
    const secret = 'ghp_0000000000000000000000000000000000000';
    const filler = `${'a'.repeat(469)} `;
    const script = await writeScript(
      'leaky-finding.sh',
      `cat <<'JSON'\n{"schema":"orcaops.evaluator_result/v2","verdict":"violation","body":"VIOLATION","findings":[{"title":"${filler}${secret} tail","detail":"${secret}"}]}\nJSON`
    );

    const out = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });

    expect(out.run.run_status).toBe('completed');
    if (out.findings.status !== 'established') throw new Error('expected established findings');
    const [finding] = out.findings.record.findings;
    expect(JSON.stringify(out.findings)).not.toContain(secret);
    expect(JSON.stringify(out.findings)).not.toContain(secret.slice(0, 20));
    expect(finding.detail).toBe('[REDACTED_SECRET]');
    expect(finding.title).toBe(`${filler}[REDACTED_SECRET] tail`);
    expect(out.findings.record.notice).toBeUndefined();
  });

  it('cannot establish findings whose identifier was redacted', async () => {
    // Redaction is the one step that can leave a key the schema refuses, and a
    // redacted key names something other than what the producer named. The
    // verdict still stands.
    const secret = 'ghp_0000000000000000000000000000000000000';
    const script = await writeScript(
      'leaky-key.sh',
      `cat <<'JSON'\n{"schema":"orcaops.evaluator_result/v2","verdict":"violation","body":"VIOLATION","findings":[{"key":"token/${secret}","title":"a statement"}]}\nJSON`
    );

    const out = await runCommandEngine({
      evaluator: makeResolved({ command: [script], package_root: tmpRoot }),
      context: makeContext(),
      run_id: RUN_ID,
    });

    expect(out.run.run_status).toBe('completed');
    expect(out.run.verdict).toBe('violation');
    if (out.findings.status !== 'unreadable') throw new Error('expected unreadable findings');
    expect(out.findings.record.detail).toMatch(/scrubbing/);
    expect(JSON.stringify(out)).not.toContain(secret);
  });
});
