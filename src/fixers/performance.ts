import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { toolFailureOutcome, toolRunFailed, type Fixer } from './types.js'
import { runCommand } from '../process.js'
import { writeInternalEslintConfig } from '../gates/performance.js'
import type { ToolRunnerDeps } from '../gates/style.js'

export function createPerformanceFixer(deps: ToolRunnerDeps = {}): Fixer {
  const run = deps.run ?? runCommand
  return {
    name: 'performance',
    async run(ctx) {
      const eslintBin = ctx.resolveTool('eslint')
      if (eslintBin === null) return { applied: false, message: 'eslint not available' }
      // writeInternalEslintConfig writes to a TEMPORARY directory outside the user's repo
      // (same rationale as the performance gate) — the caller creates and removes the whole dir.
      const configDir = mkdtempSync(join(tmpdir(), 'cliquet-eslint-fix-'))
      try {
        const configPath = writeInternalEslintConfig(configDir)
        // Paths relative to cwd (= ctx.rootPath) — same rationale as the performance gate:
        // absolute paths make ESLint 9 treat everything as "outside of the base path".
        const relativeDirs = ctx.sourceDirs.map((dir) => {
          const rel = relative(ctx.rootPath, dir)
          return rel || '.'
        })
        // exit 1 = non-fixable errors remain (fix still applied); 2+ = crash
        const r = await run(eslintBin, ['--no-config-lookup', '--config', configPath, '--fix', ...relativeDirs], {
          cwd: ctx.rootPath,
          timeoutMs: ctx.timeoutMs,
        })
        if (toolRunFailed(r)) return toolFailureOutcome('eslint', r)
      } finally {
        rmSync(configDir, { recursive: true, force: true })
      }
      return { applied: true, message: 'eslint --fix (internal performance rules)' }
    },
  }
}
