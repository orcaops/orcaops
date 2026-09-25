import { appendFile, readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  if (process.env.FAKE_CODEX_PREFLIGHT_MARKER) {
    await appendFile(process.env.FAKE_CODEX_PREFLIGHT_MARKER, 'preflight\n');
  }
  if (process.env.FAKE_CODEX_VERSION_BEHAVIOR === 'sleep') {
    globalThis.setInterval(() => undefined, 1000);
    await new Promise(() => undefined);
  }
  process.stdout.write(`${process.env.FAKE_CODEX_VERSION ?? 'codex-cli 0.154.0'}\n`);
  process.exit(Number(process.env.FAKE_CODEX_VERSION_EXIT ?? 0));
}

if (process.env.FAKE_CODEX_MODEL_MARKER) {
  await appendFile(process.env.FAKE_CODEX_MODEL_MARKER, 'model\n');
}

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;

const schemaIndex = args.indexOf('--output-schema');
const schemaPath = schemaIndex === -1 ? null : args[schemaIndex + 1];
if (process.env.FAKE_CODEX_RECORD) {
  await writeFile(
    process.env.FAKE_CODEX_RECORD,
    JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      stdin,
      schemaPath,
      schema: schemaPath ? await readFile(schemaPath, 'utf8') : null,
    })
  );
}

const behavior = process.env.FAKE_CODEX_BEHAVIOR ?? 'answer';
if (behavior === 'malformed') {
  process.stdout.write('{not-json}\n');
  process.exit(0);
}
if (behavior === 'tool-use') {
  process.stdout.write(
    `${JSON.stringify({
      type: 'item.started',
      item: { id: 'tool-1', type: 'command_execution', command: 'pwd' },
    })}\n`
  );
}
if (behavior === 'failed') {
  process.stdout.write(
    `${JSON.stringify({ type: 'turn.failed', error: { message: 'denied' } })}\n`
  );
  process.exit(1);
}

let answer =
  process.env.FAKE_CODEX_ANSWER ??
  (behavior === 'free-text' ? 'I cannot provide that JSON answer.' : '{"statements":[]}');
if (behavior === 'diagnostic-output') {
  const secret = `ghp_${'0'.repeat(36)}`;
  answer = `${'界'.repeat(40000)} ${secret} invalid final answer`;
  process.stderr.write(`${'🙂'.repeat(5000)} ${secret}\u001b[2J diagnostic end`);
}

process.stdout.write(
  [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.started' }),
    ...(behavior === 'missing-answer'
      ? []
      : [
          JSON.stringify({
            type: 'item.completed',
            item: { id: 'message-1', type: 'agent_message', text: answer },
          }),
        ]),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 8 },
    }),
  ].join('\n') + '\n'
);
