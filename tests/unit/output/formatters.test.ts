import { describe, it, expect } from 'vitest'
import { formatJson } from '../../../src/output/json.js'
import { formatHuman } from '../../../src/output/human.js'
import { formatGithub } from '../../../src/output/github.js'
import type { CheckResult } from '../../../src/types.js'

const sample: CheckResult = {
  result: 'fail',
  timestamp: '2026-07-13T10:00:00.000Z',
  summary: { total: 4, passed: 1, failed: 1, skipped: 1, errored: 1 },
  gates: [
    { name: 'security', label: 'Security Audit', status: 'pass', message: '0 findings', baseline: {}, current: {}, actions: [] },
    { name: 'style', label: 'Code Style', status: 'fail', message: '2 violations (baseline: 0)', baseline: { violations: 0 }, current: { violations: 2 }, actions: [] },
    { name: 'coverage', label: 'Test Coverage', status: 'skip', message: 'no test runner', baseline: {}, current: {}, actions: [] },
    { name: 'duplication', label: 'Duplication', status: 'error', message: 'jscpd: exploded', baseline: {}, current: {}, actions: [] },
  ],
  actions: [
    { gate: 'style', type: 'FIX STYLE', severity: 'block', priority: 2, message: 'Fix 2 style violations', files: ['src/a.ts', 'src/b.ts'] },
    { gate: 'complexity', type: 'REFACTOR CCN', severity: 'warn', priority: 9, message: '1 function with CCN > 20', files: ['src/c.ts:5 f (CCN 22)'] },
  ],
}

describe('formatJson', () => {
  it('emite o schema cliquet/v1 com summary, gates e actions', () => {
    const parsed = JSON.parse(formatJson(sample, { pretty: false }))
    expect(parsed.schema).toBe('cliquet/v1')
    expect(parsed.result).toBe('fail')
    expect(parsed.summary.errored).toBe(1)
    expect(parsed.gates).toHaveLength(4)
    expect(parsed.actions[0].gate).toBe('style')
  })
  it('pretty usa identação', () => {
    expect(formatJson(sample, { pretty: true })).toContain('\n  ')
  })
})

describe('formatHuman', () => {
  it('usa ✔/✘/–/! por status e mostra o resultado (spec §9)', () => {
    const out = formatHuman(sample, { plain: true })
    expect(out).toContain('✔ Security Audit')
    expect(out).toContain('✘ Code Style')
    expect(out).toContain('– Test Coverage')
    expect(out).toContain('! Duplication')
    expect(out).toContain('RESULT: FAIL')
    expect(out).toContain('1/4 gates passed')
  })
  it('separa Required Actions (block) de Warnings (warn)', () => {
    const out = formatHuman(sample, { plain: true })
    const requiredIdx = out.indexOf('Required Actions')
    const warningsIdx = out.indexOf('Warnings')
    expect(requiredIdx).toBeGreaterThan(-1)
    expect(warningsIdx).toBeGreaterThan(requiredIdx)
    expect(out).toContain('[1] FIX STYLE')
    expect(out).toContain('→ src/a.ts')
  })
  it('plain remove códigos ANSI', () => {
    expect(formatHuman(sample, { plain: true })).not.toMatch(/\x1b\[/)
    expect(formatHuman(sample, { plain: false })).toMatch(/\x1b\[/)
  })
  it('warning com mais de 10 files indica a contagem truncada', () => {
    const manyFiles = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`)
    const withBigWarn: CheckResult = {
      ...sample,
      actions: [{ gate: 'complexity', type: 'REFACTOR CCN', severity: 'warn', priority: 9, message: 'many', files: manyFiles }],
    }
    const out = formatHuman(withBigWarn, { plain: true })
    expect(out).toContain('and 2 more')
  })
})

describe('formatGithub', () => {
  it('block → ::error::, warn → ::warning::, gates agrupadas', () => {
    const out = formatGithub(sample)
    expect(out).toContain('::group::')
    expect(out).toContain('::error::Fix 2 style violations')
    expect(out).toContain('::warning::1 function with CCN > 20')
    expect(out).toContain('::endgroup::')
  })
})
