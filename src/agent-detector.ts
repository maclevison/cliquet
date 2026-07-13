/** Internal, extensible list (spec §3). Just ONE var needs to be present and non-empty. */
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
