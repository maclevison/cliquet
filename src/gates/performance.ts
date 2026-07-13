import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { Action, Gate, GateResult, ProjectContext } from '../types.js'
import { listSourceFiles } from '../source-files.js'
import { runCommand, tailLines } from '../process.js'
import { parseEslintJson } from './static-analysis.js'
import { analyzeConditionOrder } from './condition-order.js'
import { suggestBaselineUpdate } from './improvement.js'
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
 * Writes the internal flat config to a TEMPORARY directory (outside the user's
 * repo — a SIGKILL mid-gate won't leave junk in the project) and returns the path.
 * The caller removes the directory in a finally block. No `files` key: the object
 * applies to every linted file. Verified empirically (ESLint 9.39): `--config <path
 * outside cwd>` without `files` lints the passed targets normally, relative to cwd.
 */
export function writeInternalEslintConfig(dir: string): string {
  const path = join(dir, 'cliquet-internal.eslint.config.mjs')
  // First entry (ignores only) = flat-config GLOBAL ignores: without it eslint
  // lints build artifacts inside the source dirs (dist/ was 93% of the
  // violations on a real monorepo run).
  const ignores = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.output/**', '**/coverage/**']
  writeFileSync(
    path,
    `export default [{ ignores: ${JSON.stringify(ignores)} }, { rules: ${JSON.stringify(INTERNAL_ESLINT_RULES)} }]\n`,
  )
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

      // 1) built-in: condition order (independent of eslint — spec §5 gate 8)
      for (const file of listSourceFiles(ctx.sourceDirs)) {
        const rel = relative(ctx.rootPath, file)
        for (const f of analyzeConditionOrder(rel, readFileSync(file, 'utf8'))) {
          violations++
          locations.push(`${f.file}:${f.line} ${f.message}`)
        }
      }

      // 2) eslint with internal config, if resolvable
      const eslintBin = ctx.resolveTool('eslint')
      if (eslintBin !== null) {
        const configDir = mkdtempSync(join(tmpdir(), 'cliquet-eslint-'))
        const configPath = writeInternalEslintConfig(configDir)
        try {
          // Paths relative to cwd (= ctx.rootPath): passing absolute directories makes
          // ESLint 9 treat everything as "outside of the base path" and ignore the whole glob.
          // sourceDirs fallback can be the root itself → relative() becomes '' → use '.'.
          const relativeDirs = ctx.sourceDirs.map((dir) => {
            const rel = relative(ctx.rootPath, dir)
            return rel || '.'
          })
          const r = await run(
            eslintBin,
            ['--no-config-lookup', '--config', configPath, '--format', 'json', ...relativeDirs],
            { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs },
          )
          if (r.timedOut) {
            return { status: 'error', message: 'eslint (internal config) timed out', baseline: base, current: {}, actions: [] }
          }
          const parsed = parseEslintJson(r.stdout, ctx.rootPath)
          if (parsed === null) {
            // eslint < 9 doesn't know the flag ("Invalid option '--no-config-lookup'"):
            // degrade to just the built-ins. Narrow regex — generic patterns like
            // "invalid option" would mask real config errors in eslint 9.
            const unsupported = /no-config-lookup/i.test(r.stderr)
            // The internal config has no `files`, so it only covers eslint's default
            // extensions (.js/.mjs/.cjs/.jsx) — a sourceDir with only .ts (no TS parser
            // configured here on purpose, spec §5 gate 8) makes eslint 9 refuse with
            // "all files matching the glob pattern are ignored". Not a tool failure:
            // there's simply nothing there for the internal JS rules to check.
            const nothingToLint = /matching the glob pattern .* are ignored/i.test(r.stderr)
            if (!unsupported && !nothingToLint) {
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
          rmSync(configDir, { recursive: true, force: true })
        }
      }

      const current = { violations }
      if (violations <= base.violations) {
        const passActions =
          violations < base.violations
            ? [suggestBaselineUpdate('performance', `performance violations improved to ${violations} (baseline ${base.violations})`)]
            : []
        return {
          status: 'pass',
          message: violations === 0 ? 'No performance improvements needed' : `${violations} violations (baseline: ${base.violations})`,
          baseline: base,
          current,
          actions: passActions,
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
