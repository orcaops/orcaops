// Vendored from vercel-labs/skills@9a7d8ac (v1.5.13), MIT License.
// Upstream: https://github.com/vercel-labs/skills  — reduced to data + detection for orcaops.

export type AgentType =
  | 'aider-desk'
  | 'amp'
  | 'antigravity'
  | 'antigravity-cli'
  | 'astrbot'
  | 'autohand-code'
  | 'augment'
  | 'bob'
  | 'claude-code'
  | 'openclaw'
  | 'cline'
  | 'codearts-agent'
  | 'codebuddy'
  | 'codemaker'
  | 'codestudio'
  | 'codex'
  | 'command-code'
  | 'continue'
  | 'cortex'
  | 'crush'
  | 'cursor'
  | 'deepagents'
  | 'devin'
  | 'dexto'
  | 'droid'
  | 'eve'
  | 'firebender'
  | 'forgecode'
  | 'gemini-cli'
  | 'github-copilot'
  | 'goose'
  | 'hermes-agent'
  | 'inference-sh'
  | 'iflow-cli'
  | 'jazz'
  | 'junie'
  | 'kilo'
  | 'kimi-code-cli'
  | 'kiro-cli'
  | 'kode'
  | 'lingma'
  | 'loaf'
  | 'mcpjam'
  | 'mistral-vibe'
  | 'moxby'
  | 'mux'
  | 'neovate'
  | 'opencode'
  | 'openhands'
  | 'ona'
  | 'pi'
  | 'qoder'
  | 'qoder-cn'
  | 'qwen-code'
  | 'replit'
  | 'reasonix'
  | 'roo'
  | 'rovodev'
  | 'tabnine-cli'
  | 'terramind'
  | 'tinycloud'
  | 'trae'
  | 'trae-cn'
  | 'warp'
  | 'windsurf'
  | 'zed'
  | 'zencoder'
  | 'zenflow'
  | 'pochi'
  | 'promptscript'
  | 'adal'
  | 'universal';

export interface Skill {
  name: string;
  description: string;
  path: string;
  /** Raw SKILL.md content for hashing */
  rawContent?: string;
  /** Name of the plugin this skill belongs to (if any) */
  pluginName?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentConfig {
  name: string;
  displayName: string;
  skillsDir: string;
  /** Global skills directory. Set to undefined if the agent doesn't support global installation. */
  globalSkillsDir: string | undefined;
  detectInstalled: () => Promise<boolean>;
  /** Whether to show this agent in the universal agents list. Defaults to true. */
  showInUniversalList?: boolean;
  /** Whether to display this universal agent in the interactive locked section. Defaults to true. */
  showInUniversalPrompt?: boolean;
}
