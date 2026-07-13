import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Gate, GateResult } from '../types.js'
import { detectTestRunner } from '../detect.js'
import { runCommand, tailLines } from '../process.js'
import type { ToolRunnerDeps } from './style.js'

export function parseCoverageSummary(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { total?: { lines?: { pct?: number } } }
    const pct = parsed.total?.lines?.pct
    return typeof pct === 'number' ? pct : null
  } catch {
    return null
  }
}

const RUNNER_ARGS: Record<string, string[]> = {
  vitest: ['run', '--coverage', '--coverage.reporter=json-summary'],
  jest: ['--coverage', '--coverageReporters=json-summary'],
}

export function createCoverageGate(deps: ToolRunnerDeps = {}): Gate {
  const run = deps.run ?? runCommand

  return {
    name: 'coverage',
    label: 'Test Coverage',

    async run(ctx, baseline): Promise<GateResult> {
      const base = { percentage: baseline.coverage.percentage }
      const runner = detectTestRunner(ctx.rootPath)
      if (runner === null) {
        return { status: 'skip', message: 'no test runner (vitest/jest) in devDependencies', baseline: base, current: {}, actions: [] }
      }
      const bin = ctx.resolveTool(runner)
      if (bin === null) {
        return { status: 'skip', message: `${runner} detected but binary not found`, baseline: base, current: {}, actions: [] }
      }

      const result = await run(bin, RUNNER_ARGS[runner] ?? [], { cwd: ctx.rootPath, timeoutMs: ctx.timeoutMs })
      if (result.timedOut) {
        return { status: 'error', message: `${runner} timed out`, baseline: base, current: {}, actions: [] }
      }
      const stderr = result.stderr || result.stdout
      if (/coverage-v8|coverage-istanbul|coverage provider|babel-plugin-istanbul/i.test(stderr) && result.exitCode !== 0) {
        return {
          status: 'error',
          message: `coverage provider missing — install @vitest/coverage-v8 (vitest) or configure jest coverage. Details: ${tailLines(stderr, 5)}`,
          baseline: base,
          current: {},
          actions: [],
        }
      }

      const summaryPath = join(ctx.rootPath, 'coverage', 'coverage-summary.json')
      if (!existsSync(summaryPath)) {
        return {
          status: 'error',
          message: `${runner} ran but coverage/coverage-summary.json was not produced (custom reportsDirectory/coverageDirectory is unsupported in the MVP). Details: ${tailLines(stderr, 10)}`,
          baseline: base,
          current: {},
          actions: [],
        }
      }
      const pct = parseCoverageSummary(readFileSync(summaryPath, 'utf8'))
      if (pct === null) {
        return { status: 'error', message: 'coverage-summary.json is malformed', baseline: base, current: {}, actions: [] }
      }

      const current = { percentage: pct }
      if (pct >= base.percentage) {
        return { status: 'pass', message: `${pct.toFixed(2)}% via ${runner} (baseline: ${base.percentage.toFixed(2)}%)`, baseline: base, current, actions: [] }
      }
      return {
        status: 'fail',
        message: `${pct.toFixed(2)}% via ${runner} (baseline: ${base.percentage.toFixed(2)}%)`,
        baseline: base,
        current,
        actions: [
          {
            gate: 'coverage',
            type: 'ADD TESTS',
            severity: 'block',
            priority: 2,
            message: `Coverage dropped to ${pct.toFixed(2)}% (baseline ${base.percentage.toFixed(2)}%)`,
            files: [],
          },
        ],
      }
    },
  }
}

export const coverageGate: Gate = createCoverageGate()
