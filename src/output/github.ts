import type { CheckResult } from '../types.js'

export function formatGithub(result: CheckResult): string {
  const lines: string[] = []
  for (const gate of result.gates) {
    lines.push(`::group::${gate.label} — ${gate.status.toUpperCase()}`)
    lines.push(gate.message)
    lines.push('::endgroup::')
  }
  for (const action of result.actions) {
    const command = action.severity === 'block' ? 'error' : 'warning'
    lines.push(`::${command}::${action.message}`)
    for (const file of action.files) lines.push(`  ${file}`)
  }
  lines.push(`Result: ${result.result.toUpperCase()} — ${result.summary.passed}/${result.summary.total} gates passed`)
  return `${lines.join('\n')}\n`
}
