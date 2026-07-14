import { describe, it, expect } from 'vitest'
import { applyMeasuredBaseline } from '../../src/measure-baseline.js'
import { DEFAULT_BASELINE } from '../../src/baseline.js'
import type { CheckResult, GateReport, GateStatus } from '../../src/types.js'

function result(gates: Array<{ name: string; status: GateStatus; current?: Record<string, unknown>; message?: string }>): CheckResult {
  const reports: GateReport[] = gates.map((g) => ({
    name: g.name,
    label: g.name,
    status: g.status,
    message: g.message ?? '',
    baseline: {},
    current: g.current ?? {},
    actions: [],
  }))
  return {
    result: 'fail',
    timestamp: '2026-07-14T00:00:00.000Z',
    summary: { total: reports.length, passed: 0, failed: 0, skipped: 0, errored: 0 },
    gates: reports,
    actions: [],
  }
}

describe('applyMeasuredBaseline', () => {
  it('records the measured value of each count/ratio gate as the floor', () => {
    const { baseline, errored } = applyMeasuredBaseline(
      result([
        { name: 'security', status: 'fail', current: { advisories: 29, findings: 4 } },
        { name: 'style', status: 'fail', current: { violations: 357 } },
        { name: 'static_analysis', status: 'fail', current: { errors: 148 } },
        { name: 'duplication', status: 'fail', current: { percentage: 5.33, clones: 96 } },
        { name: 'performance', status: 'fail', current: { violations: 2 } },
        { name: 'coverage', status: 'pass', current: { percentage: 72.5 } },
      ]),
    )
    expect(baseline.security.advisories).toBe(29)
    expect(baseline.style.violations).toBe(357)
    expect(baseline.static_analysis.errors).toBe(148)
    expect(baseline.duplication.percentage).toBe(5.33)
    expect(baseline.performance.violations).toBe(2)
    expect(baseline.coverage.percentage).toBe(72.5)
    expect(errored).toEqual([])
  })

  it('keeps the default (0) and does NOT error when security audit was skipped (no advisories key)', () => {
    const { baseline, errored } = applyMeasuredBaseline(
      result([{ name: 'security', status: 'fail', current: { findings: 2 } }]),
    )
    expect(baseline.security.advisories).toBe(DEFAULT_BASELINE.security.advisories)
    expect(errored).toEqual([])
  })

  it('a count gate that ERRORED keeps the default and is reported loudly (partial baseline)', () => {
    const { baseline, errored } = applyMeasuredBaseline(
      result([{ name: 'static_analysis', status: 'error', message: 'eslint crashed', current: {} }]),
    )
    expect(baseline.static_analysis.errors).toBe(0) // default, NOT a measured lie
    expect(errored.some((e) => e.includes('static_analysis'))).toBe(true)
  })

  it('a count gate that SKIPPED keeps the default and is not an error', () => {
    const { baseline, errored } = applyMeasuredBaseline(
      result([{ name: 'style', status: 'skip', current: {} }]),
    )
    expect(baseline.style.violations).toBe(0)
    expect(errored).toEqual([])
  })

  it('coverage that is not measurable (error or skip) floors to 0 with a note, never non-zero exit', () => {
    for (const status of ['error', 'skip'] as const) {
      const { baseline, notes, errored } = applyMeasuredBaseline(
        result([{ name: 'coverage', status, message: 'tests failed', current: {} }]),
      )
      expect(baseline.coverage.percentage).toBe(0)
      expect(notes.some((n) => n.includes('coverage'))).toBe(true)
      expect(errored).toEqual([]) // coverage unmeasurable is benign, not a partial-baseline error
    }
  })

  it('grandfathers file_size / complexity offenders into their allow maps (thresholds unchanged)', () => {
    const { baseline } = applyMeasuredBaseline(
      result([
        { name: 'file_size', status: 'fail', current: { offending_files: 1, offenders: [{ file: 'src/big.ts', lines: 2030 }] } },
        { name: 'complexity', status: 'fail', current: { max_ccn: 61, violations: 1, warnings: 0, over_block: [{ id: 'src/a.ts f', ccn: 61 }] } },
      ]),
    )
    expect(baseline.file_size.max_lines).toBe(1000) // threshold unchanged
    expect(baseline.file_size.allow).toEqual({ 'src/big.ts': 2030 })
    expect(baseline.complexity.block_ccn).toBe(50) // threshold unchanged
    expect(baseline.complexity.allow).toEqual({ 'src/a.ts f': 61 })
  })

  it('notes that security findings still fail check (they are never snapshotted as a floor)', () => {
    const withFindings = applyMeasuredBaseline(
      result([{ name: 'security', status: 'fail', current: { advisories: 2, findings: 3 } }]),
    )
    expect(withFindings.notes.some((n) => /security finding/i.test(n) && /still fail/i.test(n))).toBe(true)
    const clean = applyMeasuredBaseline(
      result([{ name: 'security', status: 'pass', current: { advisories: 0, findings: 0 } }]),
    )
    expect(clean.notes.some((n) => /security finding/i.test(n))).toBe(false)
  })

  it('leaves bundle at the default (it is direct-measured by the caller, not from the gate run)', () => {
    const { baseline } = applyMeasuredBaseline(
      result([{ name: 'bundle_size', status: 'skip', current: {} }]),
    )
    expect(baseline.bundle_size.max_total_gzip_kb).toBe(DEFAULT_BASELINE.bundle_size.max_total_gzip_kb)
  })
})
