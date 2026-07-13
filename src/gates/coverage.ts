import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Gate, GateResult } from '../types.js'
import { detectTestRunner } from '../detect.js'
import { runCommand, tailLines } from '../process.js'
import { suggestBaselineUpdate } from './improvement.js'
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

      // Remove the summary from a PREVIOUS run: since reading is summary-first, a
      // stale file would be trusted if the current run failed without producing a new one.
      const summaryPath = join(ctx.rootPath, 'coverage', 'coverage-summary.json')
      rmSync(summaryPath, { force: true })

      const result = await run(bin, RUNNER_ARGS[runner] ?? [], {
        cwd: ctx.rootPath,
        timeoutMs: ctx.timeoutMs,
        // Reentrancy (vitest inside vitest during dogfooding): strip the parent
        // runner's env keys — with execa's default extendEnv, an undefined value REMOVES the key.
        env: { VITEST: undefined, VITEST_WORKER_ID: undefined, VITEST_POOL_ID: undefined },
      })
      if (result.timedOut) {
        return { status: 'error', message: `${runner} timed out`, baseline: base, current: {}, actions: [] }
      }

      // Summary first: if the report exists, it's from this run (the stale one was
      // deleted above) and it's the truth — even with exit != 0 (failing tests still
      // measure coverage). stderr might contain "coverage provider" by coincidence
      // (dump from a failing test), so it CANNOT decide on its own.
      if (existsSync(summaryPath)) {
        const pct = parseCoverageSummary(readFileSync(summaryPath, 'utf8'))
        if (pct === null) {
          return { status: 'error', message: 'coverage-summary.json is malformed', baseline: base, current: {}, actions: [] }
        }
        return buildResult(pct, base, runner)
      }

      // No summary: use stderr only to ENRICH the error message. Only an
      // EXPLICIT missing-dependency error means the provider is absent — a
      // bare package-name mention is usually a stack-trace path from tests
      // crashing under --coverage, and claiming "provider missing" there
      // sends the user chasing the wrong fix.
      const stderr = result.stderr || result.stdout
      if (/(?:cannot find (?:dependency|module)|missing dependency)\s*:?\s*['"]?(?:@vitest\/coverage-|babel-plugin-istanbul)/i.test(stderr)) {
        return {
          status: 'error',
          message: `coverage provider missing — install @vitest/coverage-v8 (vitest) or configure jest coverage. Details: ${tailLines(stderr, 5)}`,
          baseline: base,
          current: {},
          actions: [],
        }
      }
      return {
        status: 'error',
        message: `${runner} ran but coverage/coverage-summary.json was not produced (custom reportsDirectory/coverageDirectory is unsupported in the MVP). Details: ${tailLines(stderr, 10)}`,
        baseline: base,
        current: {},
        actions: [],
      }
    },
  }
}

function buildResult(pct: number, base: { percentage: number }, runner: string): GateResult {
  const current = { percentage: pct }
  const message = `${pct.toFixed(2)}% via ${runner} (baseline: ${base.percentage.toFixed(2)}%)`
  if (pct >= base.percentage) {
    const actions =
      pct > base.percentage
        ? [suggestBaselineUpdate('coverage', `coverage improved to ${pct.toFixed(2)}% (baseline ${base.percentage.toFixed(2)}%)`)]
        : []
    return { status: 'pass', message, baseline: base, current, actions }
  }
  return {
    status: 'fail',
    message,
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
}

export const coverageGate: Gate = createCoverageGate()
