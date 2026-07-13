import type { CheckResult, GateStatus } from '../types.js'

const SYMBOLS: Record<GateStatus, string> = { pass: '✔', fail: '✘', skip: '–', error: '!' }
const COLORS: Record<GateStatus, string> = { pass: '\x1b[32m', fail: '\x1b[31m', skip: '\x1b[90m', error: '\x1b[33m' }
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

function box(title: string): string {
  const inner = ` ${title} `.padEnd(50)
  return [`  ┌${'─'.repeat(50)}┐`, `  │${inner.slice(0, 50)}│`, `  └${'─'.repeat(50)}┘`].join('\n')
}

export function formatHuman(result: CheckResult, opts: { plain: boolean }): string {
  const c = (code: string, text: string) => (opts.plain ? text : `${code}${text}${RESET}`)
  const lines: string[] = []
  lines.push(box('CLIQUET — Quality Gate Report'))
  lines.push(`  ${'─'.repeat(60)}`)
  for (const gate of result.gates) {
    const symbol = SYMBOLS[gate.status]
    const label = gate.label.padEnd(24)
    const status = gate.status.toUpperCase().padEnd(6)
    lines.push(`  ${c(COLORS[gate.status], `${symbol} ${label}`)}${status} ${gate.message}`)
  }
  lines.push(`  ${'─'.repeat(60)}`)
  const verdict = result.result === 'pass' ? c(COLORS.pass, 'PASS') : c(COLORS.fail, 'FAIL')
  lines.push(`  ${c(BOLD, 'RESULT:')} ${verdict} — ${result.summary.passed}/${result.summary.total} gates passed`)

  const blocks = result.actions.filter((a) => a.severity === 'block')
  const warns = result.actions.filter((a) => a.severity === 'warn')
  if (blocks.length > 0) {
    lines.push('')
    lines.push(box('Required Actions'))
    blocks.forEach((action, i) => {
      lines.push(`  [${i + 1}] ${action.type} — ${action.message}`)
      for (const file of action.files.slice(0, 10)) lines.push(`      → ${file}`)
      if (action.files.length > 10) lines.push(`      … and ${action.files.length - 10} more`)
    })
  }
  if (warns.length > 0) {
    lines.push('')
    lines.push(box('Warnings'))
    warns.forEach((action, i) => {
      lines.push(`  [${i + 1}] ${action.type} — ${action.message}`)
      for (const file of action.files.slice(0, 10)) lines.push(`      → ${file}`)
      if (action.files.length > 10) lines.push(`      … and ${action.files.length - 10} more`)
    })
  }
  return `${lines.join('\n')}\n`
}
