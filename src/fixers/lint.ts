import type { Fixer } from './types.js'
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
        await run(eslintBin, ['--fix', '.'], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
        applied.push('eslint --fix')
      }
      const biomeBin = hasBiomeConfig(ctx.rootPath) ? ctx.resolveTool('biome') : null
      if (biomeBin) {
        await run(biomeBin, ['check', '--write', '.'], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
        applied.push('biome check --write')
      }
      return applied.length > 0
        ? { applied: true, message: applied.join(', ') }
        : { applied: false, message: 'no linter configured' }
    },
  }
}
