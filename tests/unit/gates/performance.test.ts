import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPerformanceGate, INTERNAL_ESLINT_RULES } from '../../../src/gates/performance.js'
import { DEFAULT_BASELINE } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cliquet-perf-'))
  mkdirSync(join(root, 'src'))
})

function ctxWithTools(tools: string[]) {
  const ctx = createProjectContext(root, DEFAULT_BASELINE, 300_000)
  return { ...ctx, resolveTool: (bin: string) => (tools.includes(bin) ? `/fake/bin/${bin}` : null) }
}

describe('INTERNAL_ESLINT_RULES', () => {
  it('contém exatamente as 6 regras da spec §5 gate 8', () => {
    expect(Object.keys(INTERNAL_ESLINT_RULES).sort()).toEqual([
      'no-await-in-loop',
      'no-unused-vars',
      'no-var',
      'prefer-const',
      'prefer-template',
      'require-await',
    ])
  })
})

describe('performanceGate', () => {
  it('sem eslint: roda só o built-in de condition order e falha se houver finding', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'if (expensive(x) && flag === true) { work() }')
    const gate = createPerformanceGate({ run: async () => ({ exitCode: 0, stdout: '[]', stderr: '', timedOut: false, failed: false }) })
    const r = await gate.run(ctxWithTools([]), DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.message).toContain('1 violations')
  })

  it('sem eslint e sem findings built-in: passa (não skip — spec §5 gate 8)', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'export const ok = 1')
    const gate = createPerformanceGate({ run: async () => ({ exitCode: 0, stdout: '[]', stderr: '', timedOut: false, failed: false }) })
    const r = await gate.run(ctxWithTools([]), DEFAULT_BASELINE)
    expect(r.status).toBe('pass')
  })

  it('com eslint: soma violações do eslint com as do built-in', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'export const ok = 1')
    const eslintOut = JSON.stringify([
      { filePath: '/p/src/a.ts', errorCount: 2, messages: [
        { severity: 2, line: 1 }, { severity: 2, line: 4 },
      ] },
    ])
    const gate = createPerformanceGate({
      run: async () => ({ exitCode: 1, stdout: eslintOut, stderr: '', timedOut: false, failed: false }),
    })
    const r = await gate.run(ctxWithTools(['eslint']), DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.current).toEqual({ violations: 2 })
  })
})

describe('eslint real (smoke)', () => {
  it('config interna encontra violações reais (no-var, prefer-template)', async () => {
    writeFileSync(join(root, 'src', 'bad.js'), 'var x = 1\nexport default "a" + x\n')
    const eslintBin = join(process.cwd(), 'node_modules', '.bin', 'eslint') // devDependency do próprio cliquet
    const ctx = {
      ...createProjectContext(root, DEFAULT_BASELINE, 300_000),
      resolveTool: (bin: string) => (bin === 'eslint' ? eslintBin : null),
    }
    const gate = createPerformanceGate() // sem deps → eslint real
    const r = await gate.run(ctx, DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.current.violations as number).toBeGreaterThanOrEqual(2)
  }, 60_000)
})
