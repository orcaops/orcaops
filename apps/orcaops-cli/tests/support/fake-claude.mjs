#!/usr/bin/env node
/**
 * Stand-in for the `claude` binary, reached through `ORCAOPS_CLAUDE_PATH`.
 *
 * The repo already pointed that env var at a NONEXISTENT path to make spawn
 * fail fast, which tests consent decisions and nothing downstream of them.
 * This script instead completes the call, so a test can assert on what
 * orcaops actually submitted and on how it read the response back.
 *
 * Contract with `@orcaops/llm`'s one-shot path: the prompt arrives on stdin,
 * and a single NDJSON `result` event on stdout carries the response body.
 *
 * Driven by two env vars:
 *   ORCAOPS_FAKE_CLAUDE_RECORD   file to write the received prompt + argv to
 *   ORCAOPS_FAKE_CLAUDE_RESPONSE the body to return
 */
import { writeFileSync } from 'node:fs';

// Availability detection probes `<bin> --version` with no stdin attached, so
// this has to answer without waiting for an end event that never arrives.
if (process.argv.includes('--version')) {
  process.stdout.write('fake-claude 0.0.0\n');
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  const recordPath = process.env.ORCAOPS_FAKE_CLAUDE_RECORD;
  if (recordPath) {
    writeFileSync(
      recordPath,
      JSON.stringify({ prompt: stdin, argv: process.argv.slice(2) }),
      'utf8'
    );
  }
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: process.env.ORCAOPS_FAKE_CLAUDE_RESPONSE ?? 'INFO',
      modelUsage: { 'fake-claude-model': { inputTokens: 1, outputTokens: 1 } },
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    }) + '\n'
  );
  process.exit(0);
});
