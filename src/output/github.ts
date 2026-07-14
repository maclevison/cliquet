import { join } from 'node:path'
import type { CheckResult } from '../types.js'
import { toPosix } from '../context.js'

// GitHub renders only ~10 annotations per level per step; cap so the highest-volume gate doesn't
// silently drop its annotations from the PR UI. Overflow is summarized.
const ANNOTATION_CAP = 20

// GitHub workflow-command escaping (matches @actions/core): % FIRST, then CR/LF; property values
// additionally escape "," and ":".
const escapeData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escapeProp = (s: string): string => escapeData(s).replace(/,/g, '%2C').replace(/:/g, '%3A')

/**
 * `pathPrefix` = `relative(repoRoot, rootPath)` — GitHub resolves `file=` against the checkout root,
 * but gates report paths relative to `--path`; in a monorepo subdir the two differ. Empty when they
 * coincide (the common case: cliquet run at the repo root).
 */
export function formatGithub(result: CheckResult, pathPrefix = ''): string {
  const lines: string[] = []
  for (const gate of result.gates) {
    lines.push(`::group::${gate.label} — ${gate.status.toUpperCase()}`)
    lines.push(gate.message)
    lines.push('::endgroup::')
  }

  const emitted: Record<string, number> = { error: 0, warning: 0 }
  const overflow: Record<string, number> = { error: 0, warning: 0 }
  for (const action of result.actions) {
    const cmd = action.severity === 'block' ? 'error' : 'warning'
    if (action.locations && action.locations.length > 0) {
      for (const loc of action.locations) {
        if ((emitted[cmd] ?? 0) >= ANNOTATION_CAP) {
          overflow[cmd] = (overflow[cmd] ?? 0) + 1
          continue
        }
        emitted[cmd] = (emitted[cmd] ?? 0) + 1
        const file = toPosix(pathPrefix ? join(pathPrefix, loc.file) : loc.file)
        const props = [`file=${escapeProp(file)}`]
        if (loc.line !== undefined) props.push(`line=${loc.line}`)
        lines.push(`::${cmd} ${props.join(',')}::${escapeData(loc.message ?? action.message)}`)
      }
    } else {
      // No per-source location (duplication pairs, advisories, bundle) → summary annotation + the
      // freeform files as plain log lines.
      lines.push(`::${cmd}::${escapeData(action.message)}`)
      for (const file of action.files) lines.push(`  ${file}`)
    }
  }
  for (const level of ['error', 'warning'] as const) {
    if ((overflow[level] ?? 0) > 0) {
      lines.push(`::${level}::+${overflow[level]} more ${level} annotation(s) beyond the ${ANNOTATION_CAP}-per-run cap — see the full report`)
    }
  }
  lines.push(`Result: ${result.result.toUpperCase()} — ${result.summary.passed}/${result.summary.total} gates passed`)
  return `${lines.join('\n')}\n`
}
