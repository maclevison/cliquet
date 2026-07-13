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
  it('contains exactly the 6 rules from spec §5 gate 8', () => {
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
  it('without eslint: runs only the built-in condition-order check and fails if there is a finding', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'if (expensive(x) && flag === true) { work() }')
    const gate = createPerformanceGate({ run: async () => ({ exitCode: 0, stdout: '[]', stderr: '', timedOut: false, failed: false }) })
    const r = await gate.run(ctxWithTools([]), DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.message).toContain('1 violations')
  })

  it('without eslint and no built-in findings: passes (not skip — spec §5 gate 8)', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'export const ok = 1')
    const gate = createPerformanceGate({ run: async () => ({ exitCode: 0, stdout: '[]', stderr: '', timedOut: false, failed: false }) })
    const r = await gate.run(ctxWithTools([]), DEFAULT_BASELINE)
    expect(r.status).toBe('pass')
  })

  it('with eslint: sums eslint violations with the built-in ones', async () => {
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

  it('eslint refuses to lint (fatal "all files ignored", e.g. sourceDir with only .ts): falls back to built-in only, not an error', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'export const ok = 1')
    const gate = createPerformanceGate({
      run: async () => ({
        exitCode: 2,
        stdout: '',
        stderr: 'You are linting "src", but all of the files matching the glob pattern "src" are ignored.',
        timedOut: false,
        failed: true,
      }),
    })
    const r = await gate.run(ctxWithTools(['eslint']), DEFAULT_BASELINE)
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ violations: 0 })
  })
})

describe('real eslint (smoke)', () => {
  it('internal config finds real violations (no-var, prefer-template)', async () => {
    writeFileSync(join(root, 'src', 'bad.js'), 'var x = 1\nexport default "a" + x\n')
    const eslintBin = join(process.cwd(), 'node_modules', '.bin', 'eslint') // cliquet's own devDependency
    const ctx = {
      ...createProjectContext(root, DEFAULT_BASELINE, 300_000),
      resolveTool: (bin: string) => (bin === 'eslint' ? eslintBin : null),
    }
    const gate = createPerformanceGate() // no deps → real eslint
    const r = await gate.run(ctx, DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.current.violations as number).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('does NOT lint build artifacts (dist/ produced 93% of the violations on a real repo)', async () => {
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'bundle.js'), 'var x = 1\nexport default "a" + x\n')
    writeFileSync(join(root, 'ok.js'), 'export const ok = 1\n')
    const eslintBin = join(process.cwd(), 'node_modules', '.bin', 'eslint') // cliquet's own devDependency
    const baseline = { ...DEFAULT_BASELINE, source_dirs: { paths: ['.'] } }
    const ctx = {
      ...createProjectContext(root, baseline, 300_000),
      resolveTool: (bin: string) => (bin === 'eslint' ? eslintBin : null),
    }
    const gate = createPerformanceGate() // no deps → real eslint
    const r = await gate.run(ctx, baseline)
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ violations: 0 })
  }, 60_000)

  it('sourceDir with only .ts (no TS parser configured in the internal config): not an error', async () => {
    writeFileSync(join(root, 'src', 'only.ts'), 'export const ok: number = 1\n')
    const eslintBin = join(process.cwd(), 'node_modules', '.bin', 'eslint') // cliquet's own devDependency
    const ctx = {
      ...createProjectContext(root, DEFAULT_BASELINE, 300_000),
      resolveTool: (bin: string) => (bin === 'eslint' ? eslintBin : null),
    }
    const gate = createPerformanceGate() // no deps → real eslint
    const r = await gate.run(ctx, DEFAULT_BASELINE)
    expect(r.status).not.toBe('error')
  }, 60_000)
})
