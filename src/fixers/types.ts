import type { ProjectContext } from '../types.js'
import { tailLines, type RunResult } from '../process.js'

export interface FixerOutcome {
  applied: boolean
  message: string
}

export interface Fixer {
  name: string
  run(ctx: ProjectContext): Promise<FixerOutcome>
}

/**
 * TOOL failure (not a fix failure): timeout, a process that never even ran
 * (exitCode null = spawn failure/signal), or a crash (exit 2+). Exit 0 and 1
 * count as applied — eslint --fix exits 1 when non-fixable errors remain,
 * and prettier --write exits != 0 only on a real error. Do NOT use r.failed
 * here: execa marks failed: true for ANY exit != 0, which would swallow the
 * legitimate exit 1.
 */
export function toolRunFailed(r: RunResult): boolean {
  return r.timedOut || r.exitCode === null || (r.exitCode !== 0 && r.exitCode !== 1)
}

/** Outcome `applied: false` with the tail of stderr/stdout for diagnostics. */
export function toolFailureOutcome(tool: string, r: RunResult): FixerOutcome {
  const detail = r.timedOut ? 'timed out' : tailLines(r.stderr || r.stdout || `exit ${r.exitCode}`)
  return { applied: false, message: `${tool} failed: ${detail}` }
}
