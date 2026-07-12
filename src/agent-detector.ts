/** Lista interna extensível (spec §3). Basta UMA var presente e não-vazia. */
const AGENT_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CURSOR_TRACE_ID',
  'OPENCODE',
  'GEMINI_CLI',
  'CODEX_SANDBOX',
  'AUGMENT_SESSION_ID',
] as const

export function isAiAgent(env: NodeJS.ProcessEnv = process.env): boolean {
  return AGENT_ENV_VARS.some((name) => Boolean(env[name]))
}
