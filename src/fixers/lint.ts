import { toolFailureOutcome, toolRunFailed, type Fixer } from './types.js'
import { hasBiomeConfig, hasEslintConfig } from '../detect.js'
import { runCommand } from '../process.js'
import type { ToolRunnerDeps } from '../gates/style.js'

export function createLintFixer(deps: ToolRunnerDeps = {}): Fixer {
  const run = deps.run ?? runCommand
  return {
    name: 'lint',
    async run(ctx) {
      const applied: string[] = []
      const eslintBin = hasEslintConfig(ctx.rootPath) ? ctx.resolveTool('eslint') : null
      if (eslintBin) {
        // exit 1 = non-fixable errors remain (fix still applied); 2+ = crash
        const r = await run(eslintBin, ['--fix', '.'], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
        if (toolRunFailed(r)) return toolFailureOutcome('eslint', r)
        applied.push('eslint --fix')
      }
      const biomeBin = hasBiomeConfig(ctx.rootPath) ? ctx.resolveTool('biome') : null
      if (biomeBin) {
        const r = await run(biomeBin, ['check', '--write', '.'], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
        if (toolRunFailed(r)) return toolFailureOutcome('biome', r)
        applied.push('biome check --write')
      }
      return applied.length > 0
        ? { applied: true, message: applied.join(', ') }
        : { applied: false, message: 'no linter configured' }
    },
  }
}
