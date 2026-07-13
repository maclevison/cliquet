import type { Baseline } from './baseline.js'
import type { Action, CheckResult, Gate, GateReport, ProjectContext } from './types.js'
import { securityGate } from './gates/security.js'
import { styleGate } from './gates/style.js'
import { staticAnalysisGate } from './gates/static-analysis.js'
import { coverageGate } from './gates/coverage.js'
import { duplicationGate } from './gates/duplication.js'
import { fileSizeGate } from './gates/file-size.js'
import { complexityGate } from './gates/complexity.js'
import { performanceGate } from './gates/performance.js'
import { bundleSizeGate } from './gates/bundle-size.js'

/** Ordem fixa de apresentação (spec §5). */
export const ALL_GATES: Gate[] = [
  securityGate,
  styleGate,
  staticAnalysisGate,
  coverageGate,
  duplicationGate,
  fileSizeGate,
  complexityGate,
  performanceGate,
  bundleSizeGate,
]

export async function runCheck(
  ctx: ProjectContext,
  baseline: Baseline,
  gates: Gate[] = ALL_GATES,
): Promise<CheckResult> {
  const reports: GateReport[] = await Promise.all(
    gates.map(async (gate): Promise<GateReport> => {
      try {
        const result = await gate.run(ctx, baseline)
        return { name: gate.name, label: gate.label, ...result }
      } catch (err) {
        return {
          name: gate.name,
          label: gate.label,
          status: 'error',
          message: `gate crashed: ${(err as Error).message}`,
          baseline: {},
          current: {},
          actions: [],
        }
      }
    }),
  )

  const summary = {
    total: reports.length,
    passed: reports.filter((r) => r.status === 'pass').length,
    failed: reports.filter((r) => r.status === 'fail').length,
    skipped: reports.filter((r) => r.status === 'skip').length,
    errored: reports.filter((r) => r.status === 'error').length,
  }
  const failed = summary.failed > 0 || summary.errored > 0

  const actions: Action[] = reports
    .flatMap((r) => r.actions)
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'block' ? -1 : 1
      return a.priority - b.priority
    })

  return {
    result: failed ? 'fail' : 'pass',
    timestamp: new Date().toISOString(),
    summary,
    gates: reports,
    actions,
  }
}
