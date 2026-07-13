import type { ProjectContext } from '../types.js'

export interface FixerOutcome {
  applied: boolean
  message: string
}

export interface Fixer {
  name: string
  run(ctx: ProjectContext): Promise<FixerOutcome>
}
