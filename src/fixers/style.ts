import { toolFailureOutcome, toolRunFailed, type Fixer } from './types.js'
import { hasBiomeConfig, hasPrettierConfig } from '../detect.js'
import { runCommand } from '../process.js'
import { prettierIgnoreArgs, type ToolRunnerDeps } from '../gates/style.js'

export function createStyleFixer(deps: ToolRunnerDeps = {}): Fixer {
  const run = deps.run ?? runCommand
  return {
    name: 'style',
    async run(ctx) {
      const applied: string[] = []
      const skipped: string[] = []
      // Biome first; Prettier last — last writer wins (spec §8)
      const biomeBin = hasBiomeConfig(ctx.rootPath, ctx.repoRoot) ? ctx.resolveTool('biome') : null
      if (biomeBin) {
        const r = await run(biomeBin, ['format', '--write', '.'], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
        if (toolRunFailed(r)) return toolFailureOutcome('biome', r)
        applied.push('biome format --write')
      }
      const prettierBin = hasPrettierConfig(ctx.rootPath, ctx.repoRoot) ? ctx.resolveTool('prettier') : null
      if (prettierBin) {
        const r = await run(prettierBin, ['--write', ...prettierIgnoreArgs(ctx), '.'], {
          cwd: ctx.rootPath,
          timeoutMs: ctx.timeoutMs,
        })
        if (toolRunFailed(r)) {
          // Prettier <2 can't expand the "." directory arg → "No matching files". Benign (nothing
          // to format with this prettier), same as the style GATE degrading to skip — not a crash.
          if (/No matching files/i.test(r.stderr) || /No matching files/i.test(r.stdout)) {
            skipped.push('prettier: Prettier <2 needs explicit globs, not "."')
          } else {
            return toolFailureOutcome('prettier', r)
          }
        } else {
          applied.push('prettier --write')
        }
      }
      if (applied.length > 0) return { applied: true, message: applied.join(', ') }
      if (skipped.length > 0) return { applied: false, message: skipped.join('; ') }
      return { applied: false, message: 'no formatter configured' }
    },
  }
}
