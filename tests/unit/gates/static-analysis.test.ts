import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseEslintJson,
  parseTscOutput,
  createStaticAnalysisGate,
} from '../../../src/gates/static-analysis.js'
import { DEFAULT_BASELINE, type Baseline } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'
import type { RunResult } from '../../../src/process.js'

function baselineWithExclude(exclude: string[]): Baseline {
  return { ...DEFAULT_BASELINE, source_dirs: { ...DEFAULT_BASELINE.source_dirs, exclude } }
}

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'outputs', name), 'utf8')

describe('parseEslintJson', () => {
  it('sums errorCount and extracts locations (warnings do not count)', () => {
    const r = parseEslintJson(fixture('eslint-with-errors.json'))
    expect(r?.errors).toBe(2)
    expect(r?.locations).toEqual(['/proj/src/a.ts:3', '/proj/src/b.ts:10'])
  })
  it('returns null for invalid JSON', () => {
    expect(parseEslintJson('boom')).toBeNull()
  })
})

describe('parseTscOutput', () => {
  it('counts errors and extracts file:line', () => {
    const out = [
      'src/a.ts(3,5): error TS2322: Type error.',
      "src/b.ts(10,1): error TS2304: Cannot find name 'z'.",
      'src/c.ts(1,1): warning TS0000: not a real thing.',
    ].join('\n')
    const r = parseTscOutput(out)
    expect(r.errors).toBe(2)
    expect(r.locations).toEqual(['src/a.ts:3', 'src/b.ts:10'])
  })
})

describe('staticAnalysisGate', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cliquet-sa-'))
  })

  function ctxWithTools(tools: string[], baseline: Baseline = DEFAULT_BASELINE) {
    const ctx = createProjectContext(root, baseline, 300_000)
    return { ...ctx, resolveTool: (bin: string) => (tools.includes(bin) ? `/fake/bin/${bin}` : null) }
  }

  it('skip without a linter and without tsconfig', async () => {
    const gate = createStaticAnalysisGate({ run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }) })
    const r = await gate.run(ctxWithTools(['eslint', 'tsc']), DEFAULT_BASELINE)
    expect(r.status).toBe('skip')
  })

  it('runs only tsc in a TS project without a linter', async () => {
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    const tscOut = 'src/a.ts(3,5): error TS2322: Type error.'
    const gate = createStaticAnalysisGate({
      run: async (): Promise<RunResult> => ({ exitCode: 2, stdout: tscOut, stderr: '', timedOut: false, failed: false }),
    })
    const r = await gate.run(ctxWithTools(['tsc']), DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.current).toEqual({ errors: 1 })
  })

  it('sums eslint + tsc and passes when both are clean', async () => {
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const gate = createStaticAnalysisGate({
      run: async (bin): Promise<RunResult> =>
        bin.includes('eslint')
          ? { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, failed: false }
          : { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false },
    })
    const r = await gate.run(ctxWithTools(['eslint', 'tsc']), DEFAULT_BASELINE)
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ errors: 0 })
  })

  it('error when eslint crashes with invalid JSON', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const gate = createStaticAnalysisGate({
      run: async (): Promise<RunResult> => ({ exitCode: 2, stdout: 'Oops', stderr: 'config error', timedOut: false, failed: true }),
    })
    const r = await gate.run(ctxWithTools(['eslint']), DEFAULT_BASELINE)
    expect(r.status).toBe('error')
  })

  it('passes exclude patterns as --ignore-pattern to the eslint invocation', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const seenArgs: string[] = []
    const gate = createStaticAnalysisGate({
      run: async (_bin, args): Promise<RunResult> => {
        seenArgs.push(...args)
        return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, failed: false }
      },
    })
    const baseline = baselineWithExclude(['gen'])
    await gate.run(ctxWithTools(['eslint'], baseline), baseline)
    const pairs = seenArgs.flatMap((a, i) => (a === '--ignore-pattern' ? [seenArgs[i + 1]] : []))
    expect(pairs).toEqual(['gen', 'gen/**'])
  })

  it('does not pass --ignore-pattern when source_dirs.exclude is empty', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const seenArgs: string[] = []
    const gate = createStaticAnalysisGate({
      run: async (_bin, args): Promise<RunResult> => {
        seenArgs.push(...args)
        return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, failed: false }
      },
    })
    await gate.run(ctxWithTools(['eslint']), DEFAULT_BASELINE)
    expect(seenArgs).not.toContain('--ignore-pattern')
  })

  it('skip with a distinct message when config exists but the binary does not resolve (spec §5)', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const gate = createStaticAnalysisGate({
      run: async (): Promise<RunResult> => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }),
    })
    const r = await gate.run(ctxWithTools([]), DEFAULT_BASELINE)
    expect(r.status).toBe('skip')
    expect(r.message).toContain('binary not found')
  })

  it('biome lint: warnings do not count as an error (spec §5)', async () => {
    writeFileSync(join(root, 'biome.json'), '{}')
    const biomeOut = JSON.stringify({
      diagnostics: [
        { severity: 'error', location: { path: 'src/a.ts' } },
        { severity: 'warning', location: { path: 'src/b.ts' } },
      ],
    })
    const gate = createStaticAnalysisGate({
      run: async (): Promise<RunResult> => ({ exitCode: 1, stdout: biomeOut, stderr: '', timedOut: false, failed: false }),
    })
    const r = await gate.run(ctxWithTools(['biome']), DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.current).toEqual({ errors: 1 })
  })

  it('sums eslint + biome when both are configured (spec §5)', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    writeFileSync(join(root, 'biome.json'), '{}')
    const eslintOut = JSON.stringify([{ filePath: '/p/src/a.ts', errorCount: 1, messages: [{ severity: 2, line: 2 }] }])
    const biomeOut = JSON.stringify({ diagnostics: [{ location: { path: { file: 'src/b.ts' } } }] })
    const gate = createStaticAnalysisGate({
      run: async (bin): Promise<RunResult> =>
        bin.includes('eslint')
          ? { exitCode: 1, stdout: eslintOut, stderr: '', timedOut: false, failed: false }
          : { exitCode: 1, stdout: biomeOut, stderr: '', timedOut: false, failed: false },
    })
    const r = await gate.run(ctxWithTools(['eslint', 'biome']), DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.current).toEqual({ errors: 2 })
  })
})

describe('parseEslintJson path normalization', () => {
  it('relativizes absolute filePaths against rootPath (mixed-path reports)', () => {
    const stdout = JSON.stringify([
      { filePath: '/repo/apps/web/src/a.ts', errorCount: 1, messages: [{ severity: 2, line: 7 }] },
    ])
    const r = parseEslintJson(stdout, '/repo/apps/web')
    expect(r?.locations).toEqual(['src/a.ts:7'])
  })

  it('leaves already-relative paths untouched', () => {
    const stdout = JSON.stringify([
      { filePath: 'src/a.ts', errorCount: 1, messages: [{ severity: 2, line: 7 }] },
    ])
    expect(parseEslintJson(stdout, '/repo')?.locations).toEqual(['src/a.ts:7'])
  })
})
