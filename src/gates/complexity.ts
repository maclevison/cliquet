import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import type { Action, Gate, GateResult } from '../types.js'
import { listSourceFiles } from '../source-files.js'
import { measureFileComplexity, type FunctionComplexity } from './ccn.js'

export const complexityGate: Gate = {
  name: 'complexity',
  label: 'Cyclomatic Complexity',

  async run(ctx, baseline): Promise<GateResult> {
    const { warn_ccn, block_ccn } = baseline.complexity
    const all: FunctionComplexity[] = []
    for (const file of listSourceFiles(ctx.sourceDirs)) {
      // SFCs .vue exigem extração do bloco <script> antes de parsear (pós-MVP);
      // alimentar o arquivo inteiro no parser TS produziria medições sem sentido.
      if (file.endsWith('.vue')) continue
      all.push(...measureFileComplexity(relative(ctx.rootPath, file), readFileSync(file, 'utf8')))
    }
    const blockers = all.filter((f) => f.ccn > block_ccn)
    const warnings = all.filter((f) => f.ccn > warn_ccn && f.ccn <= block_ccn)
    const maxCcn = all.reduce((max, f) => Math.max(max, f.ccn), 0)

    const actions: Action[] = []
    if (blockers.length > 0) {
      actions.push({
        gate: 'complexity',
        type: 'REFACTOR CCN',
        severity: 'block',
        priority: 3,
        message: `Refactor ${blockers.length} function(s) with CCN > ${block_ccn}`,
        files: blockers.map((f) => `${f.file}:${f.line} ${f.name} (CCN ${f.ccn})`),
      })
    }
    if (warnings.length > 0) {
      actions.push({
        gate: 'complexity',
        type: 'REFACTOR CCN',
        severity: 'warn',
        priority: 9,
        message: `${warnings.length} function(s) with CCN > ${warn_ccn}`,
        files: warnings.map((f) => `${f.file}:${f.line} ${f.name} (CCN ${f.ccn})`),
      })
    }
    return {
      status: blockers.length > 0 ? 'fail' : 'pass',
      message: `max CCN ${maxCcn}, ${blockers.length} violations (>${block_ccn}), ${warnings.length} warnings (>${warn_ccn})`,
      baseline: { warn_ccn, block_ccn },
      current: { max_ccn: maxCcn, violations: blockers.length, warnings: warnings.length },
      actions,
    }
  },
}
