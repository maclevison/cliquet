import { toolFailureOutcome, toolRunFailed, type Fixer } from './types.js'
import { hasBiomeConfig, hasPrettierConfig } from '../detect.js'
import { runCommand } from '../process.js'
import type { ToolRunnerDeps } from '../gates/style.js'

export function createStyleFixer(deps: ToolRunnerDeps = {}): Fixer {
  const run = deps.run ?? runCommand
  return {
    name: 'style',
    async run(ctx) {
      const applied: string[] = []
      // Biome primeiro; Prettier por último — last writer wins (spec §8)
      const biomeBin = hasBiomeConfig(ctx.rootPath) ? ctx.resolveTool('biome') : null
      if (biomeBin) {
        const r = await run(biomeBin, ['format', '--write', '.'], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
        if (toolRunFailed(r)) return toolFailureOutcome('biome', r)
        applied.push('biome format --write')
      }
      const prettierBin = hasPrettierConfig(ctx.rootPath) ? ctx.resolveTool('prettier') : null
      if (prettierBin) {
        const r = await run(prettierBin, ['--write', '.'], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
        if (toolRunFailed(r)) return toolFailureOutcome('prettier', r)
        applied.push('prettier --write')
      }
      return applied.length > 0
        ? { applied: true, message: applied.join(', ') }
        : { applied: false, message: 'no formatter configured' }
    },
  }
}
