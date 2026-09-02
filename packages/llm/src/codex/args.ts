export interface BuildCodexArgsParams {
  /**
   * Declared tool policy. Codex has no read-denial mechanism, so anything
   * stricter than `none` cannot be honoured here and is refused rather than
   * dropped — see {@link buildCodexArgs}.
   */
  toolPolicy?: { mode: 'none' | 'command-filtered' };
  /** Model id; null/undefined lets Codex pick its default. */
  model?: string | null;
  /**
   * Path to a file the codex CLI will write the assistant's final message to.
   * The orcaops codex provider always uses this for body capture rather than
   * parsing the JSONL event stream.
   */
  outputLastMessageFile: string;
  /** When set, request structured output via --output-schema (file-based). */
  outputSchemaFile?: string;
}

/**
 * Build CLI arguments for a `codex exec` invocation tuned for orcaops
 * evaluator runs. Choices that differ from a normal codex session:
 *
 *   --ephemeral              don't persist session state to disk
 *   --skip-git-repo-check    evaluators may run in non-git contexts
 *   -s read-only             sandbox: no file mutations, no shell escape
 *   --color never            stable text output (we capture body via file anyway)
 *   --output-last-message    write the assistant's final response to a temp
 *                            file (avoids parsing the event stream entirely)
 *   -                        read prompt from stdin
 */
export function buildCodexArgs(params: BuildCodexArgsParams): string[] {
  // Fail closed on a policy this provider cannot enforce.
  //
  // `--sandbox read-only` stops WRITES; it denies no reads, and codex has no
  // equivalent of the Claude deny-rule list. Silently dropping the policy is a
  // downgrade strictly worse than a refusal, since the caller believes a
  // restriction is in force.
  if (params.toolPolicy !== undefined && params.toolPolicy.mode !== 'none') {
    throw new TypeError(
      `Unsupported Codex tool policy mode ${JSON.stringify(params.toolPolicy.mode)}; ` +
        `codex exec has no read-denial mechanism, so only "none" can be honoured. ` +
        `Dispatch this evaluator to a provider that supports it, or relax its tool_policy.`
    );
  }

  const args: string[] = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--output-last-message',
    params.outputLastMessageFile,
  ];

  if (params.model) {
    args.push('--model', params.model);
  }

  if (params.outputSchemaFile) {
    args.push('--output-schema', params.outputSchemaFile);
  }

  // Read prompt from stdin (must come last).
  args.push('-');

  return args;
}

/**
 * Environment variables we set for every spawned `codex` process.
 * - CI=true and TERM=dumb keep the CLI in non-interactive output mode.
 */
export function buildCodexEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    CI: 'true',
    TERM: 'dumb',
    // codex-cli fires SessionStart hooks for `codex exec` too (twice per
    // session on 0.146) — an installed orcaops session hook would inject
    // capture guidance INTO evaluator runs. The hook honors this suppress
    // var and stays silent when orcaops itself is the driver.
    ORCAOPS_HOOK_SUPPRESS: '1',
  };
}
