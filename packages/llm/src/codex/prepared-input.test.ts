import { describe, expect, it } from 'vitest';

import { resolveNoToolCall } from '../provider-capabilities.js';
import {
  buildCodexPreparedInputArgs,
  codexRestrictedPreparedInputAdapter,
  interpretCodexJsonStream,
} from './prepared-input.js';

function configValues(args: string[]): string[] {
  return args.flatMap((arg, index) => (arg === '-c' ? [args[index + 1] ?? ''] : []));
}

function restrictedSettings() {
  const resolution = resolveNoToolCall({
    provider: 'codex',
    toolAccess: 'codex_restricted',
  });
  if (resolution.status !== 'available') throw new Error(JSON.stringify(resolution.refusals));
  return resolution.settings;
}

describe('Codex restricted prepared-input invocation', () => {
  it('passes the exact model and effort while isolating configuration and reading stdin', () => {
    const args = buildCodexPreparedInputArgs({
      model: 'gpt-exact',
      effort: 'high',
      outputSchemaFile: '/controlled/schema.json',
    });
    const config = configValues(args);

    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('--strict-config');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--json');
    expect(args).not.toContain('--sandbox');
    expect(args.slice(-1)).toEqual(['-']);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'gpt-exact',
    ]);
    expect(config).toContain('model_reasoning_effort="high"');
    expect(
      args.slice(args.indexOf('--output-schema'), args.indexOf('--output-schema') + 2)
    ).toEqual(['--output-schema', '/controlled/schema.json']);
  });

  it('denies local and hosted capabilities through compile-known 0.154 settings', () => {
    const config = configValues(
      buildCodexPreparedInputArgs({ model: null, effort: null, outputSchemaFile: null })
    );

    expect(config).toEqual(
      expect.arrayContaining([
        'approval_policy="never"',
        'agents.enabled=false',
        'allow_login_shell=false',
        'apps._default.enabled=false',
        'default_permissions="orcaops_restricted"',
        'features.apps=false',
        'features.browser_use=false',
        'features.computer_use=false',
        'features.hooks=false',
        'features.image_generation=false',
        'features.multi_agent=false',
        'features.plugins=false',
        'features.shell_tool=false',
        'features.unified_exec=false',
        'features.unbounded_connection_retries=false',
        'mcp_servers={}',
        'model_provider="orcaops_openai"',
        'model_providers.orcaops_openai={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false,request_max_retries=0,stream_max_retries=0}',
        'include_apps_instructions=false',
        'include_collaboration_mode_instructions=false',
        'include_environment_context=false',
        'permissions.orcaops_restricted={filesystem={":root"="deny",":minimal"="read"},network={enabled=false}}',
        'project_doc_max_bytes=0',
        'shell_environment_policy.inherit="none"',
        'skills.include_instructions=false',
        'tools.experimental_request_user_input.enabled=false',
        'tools.update_plan.enabled=false',
        'web_search="disabled"',
      ])
    );
  });

  it('accepts Codex versions at or above the minimum', () => {
    const preflight = codexRestrictedPreparedInputAdapter.preflight?.({
      settings: restrictedSettings(),
      systemPrompt: null,
      outputSchema: null,
      outputSchemaFile: null,
      baseEnv: {},
    });

    expect(preflight?.invocation.args).toEqual(['--version']);
    expect(preflight?.validate('codex-cli 0.154.0\n')).toBeNull();
    expect(preflight?.validate('codex-cli 0.154.1\n')).toBeNull();
    expect(preflight?.validate('codex-cli 0.155.1\n')).toBeNull();
    expect(preflight?.validate('codex-cli 1.0.0\n')).toBeNull();
    expect(preflight?.validate('codex-cli 0.153.9\n')).toMatch(/require codex-cli 0\.154\.0/);
    expect(preflight?.validate('codex-cli 0.154.0-beta.1\n')).toMatch(
      /require codex-cli 0\.154\.0/
    );
    expect(preflight?.validate('unexpected version\n')).toMatch(/require codex-cli 0\.154\.0/);
  });
});

describe('interpretCodexJsonStream', () => {
  it('returns the final agent message and reported token usage', () => {
    const outcome = interpretCodexJsonStream(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'item-1', type: 'agent_message', text: '{"statements":[]}' },
        }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 },
        }),
      ].join('\n'),
      true
    );

    expect(outcome).toMatchObject({
      resultCount: 1,
      body: '{"statements":[]}',
      reportedModel: null,
      usage: { in: 315, out: 122, cacheRead: 24448 },
      costUsd: null,
      failure: null,
      toolUse: [],
      toolsAvailable: [],
      toolOfferStated: false,
      structuredAnswerMissing: false,
    });
  });

  it('normalizes cached input and preserves reported cache writes', () => {
    const outcome = interpretCodexJsonStream(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'message-1', type: 'agent_message', text: 'done' },
        }),
        JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            cache_write_input_tokens: 12,
            output_tokens: 5,
          },
        }),
      ].join('\n'),
      false
    );

    expect(outcome.usage).toEqual({ in: 60, out: 5, cacheRead: 40, cacheWrite: 12 });
  });

  it.each(['command_execution', 'file_change', 'mcp_tool_call', 'web_search'])(
    'reports an observed %s item as tool use',
    (type) => {
      const outcome = interpretCodexJsonStream(
        [
          JSON.stringify({ type: 'item.started', item: { id: 'tool-1', type } }),
          JSON.stringify({ type: 'item.completed', item: { id: 'tool-1', type } }),
          JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ].join('\n'),
        false
      );

      expect(outcome.toolUse).toEqual([type]);
    }
  );

  it('fails closed on an unrecognized item type', () => {
    const outcome = interpretCodexJsonStream(
      [
        JSON.stringify({ type: 'item.completed', item: { id: 'new-1', type: 'future_tool' } }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ].join('\n'),
      false
    );

    expect(outcome.toolUse).toEqual(['future_tool']);
  });

  it('reports malformed JSON and failed turns as provider failures', () => {
    const malformed = interpretCodexJsonStream('{not-json}\n', false);
    const failed = interpretCodexJsonStream(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'not logged in' } }),
      ].join('\n'),
      false
    );

    expect(malformed.failure?.message).toMatch(/invalid JSON on line 1/);
    expect(failed).toMatchObject({
      resultCount: 1,
      failure: { kind: 'provider_error', message: 'not logged in' },
    });
  });

  it('rejects unknown top-level events and malformed item events', () => {
    const outcome = interpretCodexJsonStream(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'tool.called', tool: 'future_tool' }),
        JSON.stringify({ type: 'item.completed', item: { id: 'bad-item' } }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ].join('\n'),
      false
    );

    expect(outcome.resultCount).toBe(1);
    expect(outcome.failure?.message).toMatch(/unsupported event type.*tool\.called/);
    expect(outcome.failure?.message).toMatch(/malformed item\.completed/);
  });

  it('reports an error item as a provider failure instead of tool use', () => {
    const outcome = interpretCodexJsonStream(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'error-1', type: 'error', message: 'Code Mode is unavailable' },
        }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ].join('\n'),
      false
    );

    expect(outcome.toolUse).toEqual([]);
    expect(outcome.failure?.message).toContain('Code Mode is unavailable');
  });

  it('allows commentary messages but requires valid JSON in the final structured message', () => {
    const valid = interpretCodexJsonStream(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'message-1', type: 'agent_message', text: 'Working on it.' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'message-2', type: 'agent_message', text: '{"statements":[]}' },
        }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 2, output_tokens: 2 },
        }),
      ].join('\n'),
      true
    );
    const invalid = interpretCodexJsonStream(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'message-1', type: 'agent_message', text: 'not JSON' },
        }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ].join('\n'),
      true
    );

    expect(valid.body).toBe('{"statements":[]}');
    expect(valid.structuredAnswerMissing).toBe(false);
    expect(invalid.structuredAnswerMissing).toBe(true);
  });

  it('rejects events after the terminal turn event', () => {
    const outcome = interpretCodexJsonStream(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'message-1', type: 'agent_message', text: '{"late":true}' },
        }),
      ].join('\n'),
      true
    );

    expect(outcome.failure?.message).toMatch(/after the terminal turn event/);
  });
});
