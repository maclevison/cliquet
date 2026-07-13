import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseEslintJson,
  parseTscOutput,
  createStaticAnalysisGate,
} from '../../../src/gates/static-analysis.js'
import { DEFAULT_BASELINE } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'
import type { RunResult } from '../../../src/process.js'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'outputs', name), 'utf8')

describe('parseEslintJson', () => {
  it('soma errorCount e extrai localizações (warnings não contam)', () => {
    const r = parseEslintJson(fixture('eslint-with-errors.json'))
    expect(r?.errors).toBe(2)
    expect(r?.locations).toEqual(['/proj/src/a.ts:3', '/proj/src/b.ts:10'])
  })
  it('retorna null para JSON inválido', () => {
    expect(parseEslintJson('boom')).toBeNull()
  })
})

describe('parseTscOutput', () => {
  it('conta erros e extrai arquivo:linha', () => {
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

  function ctxWithTools(tools: string[]) {
    const ctx = createProjectContext(root, DEFAULT_BASELINE, 300_000)
    return { ...ctx, resolveTool: (bin: string) => (tools.includes(bin) ? `/fake/bin/${bin}` : null) }
  }

  it('skip sem linter e sem tsconfig', async () => {
    const gate = createStaticAnalysisGate({ run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }) })
    const r = await gate.run(ctxWithTools(['eslint', 'tsc']), DEFAULT_BASELINE)
    expect(r.status).toBe('skip')
  })

  it('roda só o tsc em projeto TS sem linter', async () => {
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    const tscOut = 'src/a.ts(3,5): error TS2322: Type error.'
    const gate = createStaticAnalysisGate({
      run: async (): Promise<RunResult> => ({ exitCode: 2, stdout: tscOut, stderr: '', timedOut: false, failed: false }),
    })
    const r = await gate.run(ctxWithTools(['tsc']), DEFAULT_BASELINE)
    expect(r.status).toBe('fail')
    expect(r.current).toEqual({ errors: 1 })
  })

  it('soma eslint + tsc e passa quando ambos limpos', async () => {
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

  it('error quando eslint crasha com JSON inválido', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const gate = createStaticAnalysisGate({
      run: async (): Promise<RunResult> => ({ exitCode: 2, stdout: 'Oops', stderr: 'config error', timedOut: false, failed: true }),
    })
    const r = await gate.run(ctxWithTools(['eslint']), DEFAULT_BASELINE)
    expect(r.status).toBe('error')
  })

  it('skip com mensagem distinta quando config existe mas binário não resolve (spec §5)', async () => {
    writeFileSync(join(root, 'eslint.config.mjs'), '')
    const gate = createStaticAnalysisGate({
      run: async (): Promise<RunResult> => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }),
    })
    const r = await gate.run(ctxWithTools([]), DEFAULT_BASELINE)
    expect(r.status).toBe('skip')
    expect(r.message).toContain('binary not found')
  })

  it('soma eslint + biome quando ambos configurados (spec §5)', async () => {
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
