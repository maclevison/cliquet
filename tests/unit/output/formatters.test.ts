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
  it('emits the cliquet/v1 schema with summary, gates and actions', () => {
    const parsed = JSON.parse(formatJson(sample, { pretty: false }))
    expect(parsed.schema).toBe('cliquet/v1')
    expect(parsed.result).toBe('fail')
    expect(parsed.summary.errored).toBe(1)
    expect(parsed.gates).toHaveLength(4)
    expect(parsed.actions[0].gate).toBe('style')
  })
  it('gates[] do not carry embedded actions — only the top-level actions[] (schema spec §9)', () => {
    const parsed = JSON.parse(formatJson(sample, { pretty: false })) as {
      gates: Array<Record<string, unknown>>
      actions: unknown[]
    }
    for (const gate of parsed.gates) {
      expect('actions' in gate).toBe(false)
      expect(Object.keys(gate).sort()).toEqual(['baseline', 'current', 'label', 'message', 'name', 'status'])
    }
    expect(parsed.actions).toHaveLength(2) // top-level preserved
  })
  it('pretty uses indentation', () => {
    expect(formatJson(sample, { pretty: true })).toContain('\n  ')
  })
})

describe('formatHuman', () => {
  it('uses ✔/✘/–/! per status and shows the result (spec §9)', () => {
    const out = formatHuman(sample, { plain: true })
    expect(out).toContain('✔ Security Audit')
    expect(out).toContain('✘ Code Style')
    expect(out).toContain('– Test Coverage')
    expect(out).toContain('! Duplication')
    expect(out).toContain('RESULT: FAIL')
    expect(out).toContain('1/4 gates passed')
  })
  it('separates Required Actions (block) from Warnings (warn)', () => {
    const out = formatHuman(sample, { plain: true })
    const requiredIdx = out.indexOf('Required Actions')
    const warningsIdx = out.indexOf('Warnings')
    expect(requiredIdx).toBeGreaterThan(-1)
    expect(warningsIdx).toBeGreaterThan(requiredIdx)
    expect(out).toContain('[1] FIX STYLE')
    expect(out).toContain('→ src/a.ts')
  })
  it('plain removes ANSI codes', () => {
    expect(formatHuman(sample, { plain: true })).not.toMatch(/\x1b\[/)
    expect(formatHuman(sample, { plain: false })).toMatch(/\x1b\[/)
  })
  it('warning with more than 10 files shows the truncated count', () => {
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
  it('block → ::error::, warn → ::warning::, gates grouped (summary fallback when no locations)', () => {
    const out = formatGithub(sample)
    expect(out).toContain('::group::')
    expect(out).toContain('::error::Fix 2 style violations')
    expect(out).toContain('::warning::1 function with CCN > 20')
    expect(out).toContain('::endgroup::')
    expect(out).toContain('  src/a.ts') // freeform dump for locationless actions
  })

  it('emits inline annotations (file,line,message) when an action has locations', () => {
    const r: CheckResult = {
      ...sample,
      actions: [
        {
          gate: 'security',
          type: 'FIX SEC',
          severity: 'block',
          priority: 0,
          message: 'Fix 1 security finding(s)',
          files: ['src/a.ts:7 [eval_usage] Dynamic code evaluation'],
          locations: [{ file: 'src/a.ts', line: 7, message: '[eval_usage] Dynamic code evaluation' }],
        },
      ],
    }
    expect(formatGithub(r)).toContain('::error file=src/a.ts,line=7::[eval_usage] Dynamic code evaluation')
  })

  it('omits line for file-level locations, escapes the message, and prepends the path prefix', () => {
    const r: CheckResult = {
      ...sample,
      actions: [
        {
          gate: 'style',
          type: 'FIX STYLE',
          severity: 'block',
          priority: 2,
          message: 'Fix style',
          files: ['src/x.ts'],
          locations: [{ file: 'src/x.ts', message: 'line one\nline two' }],
        },
      ],
    }
    const out = formatGithub(r, 'apps/web')
    expect(out).toContain('::error file=apps/web/src/x.ts::line one%0Aline two')
    expect(out).not.toMatch(/file=[^:]*:[0-9]/) // no line= for a file-level location
  })

  it('caps annotations and summarizes the overflow', () => {
    const locations = Array.from({ length: 25 }, (_, i) => ({ file: `src/f${i}.ts`, line: i + 1, message: 'err' }))
    const r: CheckResult = {
      ...sample,
      actions: [{ gate: 'static_analysis', type: 'FIX SA', severity: 'block', priority: 1, message: '25 errors', files: [], locations }],
    }
    const out = formatGithub(r)
    const emitted = (out.match(/::error file=/g) ?? []).length
    expect(emitted).toBe(20)
    expect(out).toMatch(/\+5 more error annotation/)
  })
})
