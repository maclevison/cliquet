import type { Action, Gate, GateResult, ProjectContext } from '../types.js'
import { hasBiomeConfig, hasEslintConfig, hasTsconfig } from '../detect.js'
import { runCommand, tailLines } from '../process.js'
import { parseBiomeDiagnostics, type ToolRunnerDeps } from './style.js'

export interface AnalysisCounts {
  errors: number
  locations: string[]
}

export function parseEslintJson(stdout: string): AnalysisCounts | null {
  try {
    const parsed = JSON.parse(stdout) as Array<{
      filePath: string
      errorCount: number
      messages: Array<{ severity: number; line: number }>
    }>
    if (!Array.isArray(parsed)) return null
    const errors = parsed.reduce((sum, f) => sum + f.errorCount, 0)
    const locations = parsed.flatMap((f) =>
      f.messages.filter((m) => m.severity === 2).map((m) => `${f.filePath}:${m.line}`),
    )
    return { errors, locations }
  } catch {
    return null
  }
}

const TSC_ERROR_PATTERN = /^(.+)\((\d+),\d+\): error TS\d+/

export function parseTscOutput(output: string): AnalysisCounts {
  const locations: string[] = []
  for (const line of output.split('\n')) {
    const match = TSC_ERROR_PATTERN.exec(line.trim())
    if (match) locations.push(`${match[1]}:${match[2]}`)
  }
  return { errors: locations.length, locations }
}

export function createStaticAnalysisGate(deps: ToolRunnerDeps = {}): Gate {
  const run = deps.run ?? runCommand

  return {
    name: 'static_analysis',
    label: 'Static Analysis',

    async run(ctx, baseline): Promise<GateResult> {
      const base = { errors: baseline.static_analysis.errors }
      const jobs: Array<{ name: string; exec: () => Promise<AnalysisCounts | { error: string }> }> = []

      const eslintBin = hasEslintConfig(ctx.rootPath) ? ctx.resolveTool('eslint') : null
      if (eslintBin) {
        jobs.push({
          name: 'eslint',
          exec: async () => {
            const r = await run(eslintBin, ['--format', 'json', '.'], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
            if (r.timedOut) return { error: 'eslint timed out' }
            const parsed = parseEslintJson(r.stdout)
            if (parsed === null) return { error: tailLines(r.stderr || r.stdout || 'eslint failed') }
            return parsed
          },
        })
      }

      const biomeBin = hasBiomeConfig(ctx.rootPath) ? ctx.resolveTool('biome') : null
      if (biomeBin) {
        jobs.push({
          name: 'biome',
          exec: async () => {
            const r = await run(biomeBin, ['lint', '--reporter=json', '.'], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
            if (r.timedOut) return { error: 'biome timed out' }
            if (r.exitCode === 0) return { errors: 0, locations: [] }
            const files = parseBiomeDiagnostics(r.stdout)
            if (files.length === 0) return { error: tailLines(r.stderr || r.stdout || 'biome failed') }
            return { errors: files.length, locations: files }
          },
        })
      }

      const tscBin = hasTsconfig(ctx.rootPath) ? ctx.resolveTool('tsc') : null
      if (tscBin) {
        jobs.push({
          name: 'tsc',
          exec: async () => {
            const r = await run(tscBin, ['--noEmit', '--pretty', 'false'], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
            if (r.timedOut) return { error: 'tsc timed out' }
            // tsc: exit 0 limpo; exit != 0 com erros parseáveis no stdout; senão crash
            const parsed = parseTscOutput(r.stdout)
            if (r.exitCode !== 0 && parsed.errors === 0) return { error: tailLines(r.stderr || r.stdout || 'tsc failed') }
            return parsed
          },
        })
      }

      if (jobs.length === 0) {
        const anyConfigured =
          hasEslintConfig(ctx.rootPath) || hasBiomeConfig(ctx.rootPath) || hasTsconfig(ctx.rootPath)
        return {
          status: 'skip',
          message: anyConfigured ? 'tools configured but binary not found' : 'no linter or tsconfig found',
          baseline: base,
          current: {},
          actions: [],
        }
      }

      let errors = 0
      const locations: string[] = []
      for (const job of jobs) {
        const outcome = await job.exec()
        if ('error' in outcome) {
          return { status: 'error', message: `${job.name}: ${outcome.error}`, baseline: base, current: {}, actions: [] }
        }
        errors += outcome.errors
        locations.push(...outcome.locations)
      }

      const current = { errors }
      if (errors <= base.errors) {
        return { status: 'pass', message: `${errors} errors (baseline: ${base.errors})`, baseline: base, current, actions: [] }
      }
      const actions: Action[] = [
        {
          gate: 'static_analysis',
          type: 'FIX SA',
          severity: 'block',
          priority: 1,
          message: `Fix ${errors} static analysis error(s)`,
          files: locations,
        },
      ]
      return { status: 'fail', message: `${errors} errors (baseline: ${base.errors})`, baseline: base, current, actions }
    },
  }
}

export const staticAnalysisGate: Gate = createStaticAnalysisGate()
