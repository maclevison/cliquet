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
 * Falha de FERRAMENTA (não do fix): timeout, processo que nem executou, ou crash.
 * Exit 0 e 1 contam como aplicado — eslint --fix sai 1 quando restam erros
 * não-corrigíveis e prettier --write sai != 0 só em erro real; 2+ é crash.
 */
export function toolRunFailed(r: RunResult): boolean {
  return r.timedOut || r.failed || (r.exitCode !== 0 && r.exitCode !== 1)
}

/** Outcome `applied: false` com o rabo do stderr/stdout para diagnóstico. */
export function toolFailureOutcome(tool: string, r: RunResult): FixerOutcome {
  const detail = r.timedOut ? 'timed out' : tailLines(r.stderr || r.stdout || `exit ${r.exitCode}`)
  return { applied: false, message: `${tool} failed: ${detail}` }
}
