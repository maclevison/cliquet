import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Action, Gate, GateResult, ProjectContext } from '../types.js'
import { listSourceFiles } from '../source-files.js'
import { runCommand, tailLines } from '../process.js'
import { parseEslintJson } from './static-analysis.js'
import { analyzeConditionOrder } from './condition-order.js'
import type { ToolRunnerDeps } from './style.js'

export const INTERNAL_ESLINT_RULES: Record<string, string> = {
  'no-unused-vars': 'error',
  'prefer-const': 'error',
  'no-var': 'error',
  'prefer-template': 'error',
  'no-await-in-loop': 'error',
  'require-await': 'error',
}

/**
 * Grava a flat config interna NA RAIZ do projeto-alvo (globs de flat config
 * resolvem relativos à config) e retorna o path. Caller remove em finally.
 * Sem chave `files`: o objeto se aplica a todo arquivo lintado.
 */
export function writeInternalEslintConfig(rootPath: string): string {
  const path = join(rootPath, '.cliquet-internal.eslint.config.mjs')
  writeFileSync(path, `export default [{ rules: ${JSON.stringify(INTERNAL_ESLINT_RULES)} }]\n`)
  return path
}

export function createPerformanceGate(deps: ToolRunnerDeps = {}): Gate {
  const run = deps.run ?? runCommand

  return {
    name: 'performance',
    label: 'Performance',

    async run(ctx: ProjectContext, baseline): Promise<GateResult> {
      const base = { violations: baseline.performance.violations }
      let violations = 0
      const locations: string[] = []

      // 1) built-in: condition order (independe de eslint — spec §5 gate 8)
      for (const file of listSourceFiles(ctx.sourceDirs)) {
        const rel = relative(ctx.rootPath, file)
        for (const f of analyzeConditionOrder(rel, readFileSync(file, 'utf8'))) {
          violations++
          locations.push(`${f.file}:${f.line} ${f.message}`)
        }
      }

      // 2) eslint com config interna, se resolvível
      const eslintBin = ctx.resolveTool('eslint')
      if (eslintBin !== null) {
        const configPath = writeInternalEslintConfig(ctx.rootPath)
        try {
          // Paths relativos ao cwd (= ctx.rootPath): passar diretórios absolutos faz o
          // ESLint 9 tratar tudo como "outside of the base path" e ignorar o glob inteiro.
          const relativeDirs = ctx.sourceDirs.map((dir) => relative(ctx.rootPath, dir))
          const r = await run(
            eslintBin,
            ['--no-config-lookup', '--config', configPath, '--format', 'json', ...relativeDirs],
            { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs },
          )
          if (r.timedOut) {
            return { status: 'error', message: 'eslint (internal config) timed out', baseline: base, current: {}, actions: [] }
          }
          const parsed = parseEslintJson(r.stdout)
          if (parsed === null) {
            // eslint < 9 não conhece --no-config-lookup: degrada para só os built-ins
            const unsupported = /no-config-lookup|unknown option|invalid option/i.test(r.stderr)
            if (!unsupported) {
              return {
                status: 'error',
                message: `eslint (internal config): ${tailLines(r.stderr || r.stdout || 'failed')}`,
                baseline: base,
                current: {},
                actions: [],
              }
            }
          } else {
            violations += parsed.errors
            locations.push(...parsed.locations)
          }
        } finally {
          rmSync(configPath, { force: true })
        }
      }

      const current = { violations }
      if (violations <= base.violations) {
        return {
          status: 'pass',
          message: violations === 0 ? 'No performance improvements needed' : `${violations} violations (baseline: ${base.violations})`,
          baseline: base,
          current,
          actions: [],
        }
      }
      const actions: Action[] = [
        {
          gate: 'performance',
          type: 'FIX PERF',
          severity: 'block',
          priority: 6,
          message: `Fix ${violations} performance violation(s) — \`cliquet fix\` resolves the ESLint ones`,
          files: locations,
        },
      ]
      return { status: 'fail', message: `${violations} violations (baseline: ${base.violations})`, baseline: base, current, actions }
    },
  }
}

export const performanceGate: Gate = createPerformanceGate()
