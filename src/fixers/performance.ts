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
      // writeInternalEslintConfig grava num diretório TEMPORÁRIO fora do repo do usuário
      // (mesmo racional do gate de performance) — o caller cria e remove o dir inteiro.
      const configDir = mkdtempSync(join(tmpdir(), 'cliquet-eslint-fix-'))
      try {
        const configPath = writeInternalEslintConfig(configDir)
        // Paths relativos ao cwd (= ctx.rootPath) — mesmo racional do gate de performance:
        // absolutos fazem o ESLint 9 tratar tudo como "outside of the base path".
        const relativeDirs = ctx.sourceDirs.map((dir) => relative(ctx.rootPath, dir) || '.')
        // exit 1 = restaram erros não-corrigíveis (fix aplicado mesmo assim); 2+ = crash
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
