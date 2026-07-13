import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Fixer } from './types.js'
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
        await run(eslintBin, ['--no-config-lookup', '--config', configPath, '--fix', ...ctx.sourceDirs], {
          cwd: ctx.rootPath,
          timeoutMs: ctx.timeoutMs,
        })
      } finally {
        rmSync(configDir, { recursive: true, force: true })
      }
      return { applied: true, message: 'eslint --fix (internal performance rules)' }
    },
  }
}
