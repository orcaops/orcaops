import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { setInterval } from 'node:timers';

const behavior = process.env.FAKE_PROVIDER_BEHAVIOR ?? 'answer';
const recordPath = process.env.FAKE_PROVIDER_RECORD;
const bodyBytes = Number(process.env.FAKE_PROVIDER_BODY_BYTES ?? '0');

const RECORDED_ENV_KEYS = [
  'ORCAOPS_HOOK_SUPPRESS',
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_ENTRYPOINT',
  'CI',
  'TERM',
];

const ignoresSigterm = behavior === 'ignore-sigterm' || behavior === 'spawn-grandchild';
if (ignoresSigterm) process.on('SIGTERM', () => {});

const stdin = await readStdin();

let grandchildPid = null;
if (behavior === 'spawn-grandchild') {
  const grandchild = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
    { stdio: 'inherit' }
  );
  grandchildPid = grandchild.pid ?? null;
}

if (recordPath) {
  const record = {
    argv: process.argv.slice(2),
    env: Object.fromEntries(RECORDED_ENV_KEYS.map((key) => [key, process.env[key] ?? null])),
    cwd: process.cwd(),
    stdin,
    pid: process.pid,
    grandchildPid,
  };
  // Renamed into place so a reader polling for the file never sees half of it.
  writeFileSync(`${recordPath}.partial`, JSON.stringify(record));
  renameSync(`${recordPath}.partial`, recordPath);
}

const usage = {
  input_tokens: 120,
  output_tokens: 45,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 0,
};
const modelUsage = { 'fake-model-1': { provider: 'firstParty' } };
const answer =
  process.env.FAKE_PROVIDER_ANSWER ?? (bodyBytes > 0 ? 'a'.repeat(bodyBytes) : '{"statements":[]}');
const structuredAnswer = { statements: ['s1'] };

const init = (extra = {}) => ({
  type: 'system',
  subtype: 'init',
  tools: [],
  mcp_servers: [],
  ...extra,
});
const assistant = (content, extra = {}) => ({ type: 'assistant', message: { content, ...extra } });
const spoken = assistant([{ type: 'text', text: answer }]);
const result = (extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: answer,
  stop_reason: 'end_turn',
  usage,
  modelUsage,
  total_cost_usd: 0.0123,
  ...extra,
});
const structuredCall = assistant(
  [{ type: 'tool_use', id: 'toolu_answer', name: 'StructuredOutput', input: structuredAnswer }],
  { stop_reason: 'tool_use' }
);
const structuredCallResult = {
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_answer', content: 'ok' }] },
};
const structuredResult = result({ result: '', structured_output: structuredAnswer });

/** What each scripted behaviour writes before exiting. */
const scripts = {
  answer: { events: [init(), spoken, result()] },
  'answer-without-usage': {
    events: [
      init(),
      spoken,
      result({
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: undefined,
        total_cost_usd: 0,
      }),
    ],
  },
  'answer-with-half-reported-usage': {
    events: [init(), spoken, result({ usage: { input_tokens: 10 } })],
  },
  'structured-answer': {
    events: [
      init({ tools: ['StructuredOutput'] }),
      structuredCall,
      structuredCallResult,
      structuredResult,
    ],
  },
  'tool-use': {
    events: [
      init(),
      assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } }]),
      spoken,
      result(),
    ],
  },
  'tool-use-in-stream-event': {
    events: [
      init(),
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } },
      },
      spoken,
      result(),
    ],
  },
  'tool-result': {
    events: [
      init(),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9' }] } },
      spoken,
      result(),
    ],
  },
  'permission-denials': {
    events: [
      init(),
      spoken,
      result({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_2' }] }),
    ],
  },
  'init-lists-tools': {
    events: [init({ tools: ['Bash', 'Read', 'Write'] }), spoken, result()],
  },
  'init-lists-connected-mcp-server': {
    events: [init({ mcp_servers: [{ name: 'tracker', status: 'connected' }] }), spoken, result()],
  },
  'init-lists-failed-mcp-server': {
    events: [init({ mcp_servers: [{ name: 'tracker', status: 'failed' }] }), spoken, result()],
  },
  'no-init': { events: [spoken, result()] },
  'init-without-tool-list': {
    events: [{ type: 'system', subtype: 'init' }, spoken, result()],
  },
  'cut-off-in-result': { events: [init(), spoken, result({ stop_reason: 'max_tokens' })] },
  'cut-off-in-assistant-event': {
    events: [
      init(),
      assistant([{ type: 'text', text: answer }], { stop_reason: 'max_tokens' }),
      result({ stop_reason: undefined }),
    ],
  },
  'error-then-success': {
    events: [
      init(),
      result({ is_error: true, subtype: 'error_during_execution', total_cost_usd: 0.05 }),
      result({ usage: { input_tokens: 500, output_tokens: 20 }, total_cost_usd: 0.01 }),
    ],
  },
  'success-then-error-without-usage': {
    events: [
      init(),
      result(),
      result({
        is_error: true,
        subtype: 'error_during_execution',
        usage: undefined,
        modelUsage: undefined,
        total_cost_usd: undefined,
      }),
    ],
  },
  'empty-body': { events: [init(), result({ result: '   ', total_cost_usd: 0.004 })] },
  'no-result': { text: 'this is not a stream event\n' },
  'budget-exceeded': {
    events: [
      init(),
      result({
        subtype: 'error_max_budget_usd',
        is_error: true,
        result: '',
        errors: ['Reached maximum budget ($0.0500)'],
        total_cost_usd: 0.0512,
      }),
    ],
    exitCode: 1,
  },
  'exit-nonzero': { stderr: 'fake provider: not logged in\n', exitCode: 3 },
};

const script = scripts[behavior];
if (script !== undefined) {
  for (const event of script.events ?? []) process.stdout.write(`${JSON.stringify(event)}\n`);
  if (script.text) process.stdout.write(script.text);
  if (script.stderr) process.stderr.write(script.stderr);
  process.exitCode = script.exitCode ?? 0;
} else if (behavior === 'flood-without-newline') {
  await floodForever();
} else if (['sleep', 'ignore-sigterm', 'spawn-grandchild'].includes(behavior)) {
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(`unknown FAKE_PROVIDER_BEHAVIOR: ${behavior}\n`);
  process.exitCode = 64;
}

async function floodForever() {
  const chunk = Buffer.alloc(64 * 1024, 'x');
  for (;;) {
    if (!process.stdout.write(chunk)) {
      await new Promise((resolve) => process.stdout.once('drain', resolve));
    }
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
