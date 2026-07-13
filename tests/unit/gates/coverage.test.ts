import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCoverageSummary, createCoverageGate } from '../../../src/gates/coverage.js'
import { DEFAULT_BASELINE, type Baseline } from '../../../src/baseline.js'
import { createProjectContext } from '../../../src/context.js'

const fixturePath = join(import.meta.dirname, '..', '..', 'fixtures', 'outputs', 'coverage-summary.json')

describe('parseCoverageSummary', () => {
  it('extrai total.lines.pct', () => {
    expect(parseCoverageSummary(readFileSync(fixturePath, 'utf8'))).toBe(87.0)
  })
  it('retorna null para JSON inválido ou sem total', () => {
    expect(parseCoverageSummary('nope')).toBeNull()
    expect(parseCoverageSummary('{}')).toBeNull()
  })
})

describe('coverageGate', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cliquet-cov-'))
  })

  function withVitest() {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }))
  }

  function baselineWith(pct: number): Baseline {
    return { ...DEFAULT_BASELINE, coverage: { percentage: pct } }
  }

  function ctxWithTools(tools: string[]) {
    const ctx = createProjectContext(root, DEFAULT_BASELINE, 300_000)
    return { ...ctx, resolveTool: (bin: string) => (tools.includes(bin) ? `/fake/bin/${bin}` : null) }
  }

  it('skip sem runner detectado', async () => {
    const gate = createCoverageGate({ run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }) })
    const r = await gate.run(ctxWithTools(['vitest']), DEFAULT_BASELINE)
    expect(r.status).toBe('skip')
  })

  it('passa quando coverage ≥ baseline', async () => {
    withVitest()
    const gate = createCoverageGate({
      run: async () => {
        // simula o runner gravando o relatório
        mkdirSync(join(root, 'coverage'), { recursive: true })
        cpSync(fixturePath, join(root, 'coverage', 'coverage-summary.json'))
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
      },
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ percentage: 87.0 })
    expect(r.message).toContain('vitest') // reporta qual runner usou (spec §5 gate 4)
  })

  it('falha quando coverage < baseline', async () => {
    withVitest()
    const gate = createCoverageGate({
      run: async () => {
        mkdirSync(join(root, 'coverage'), { recursive: true })
        cpSync(fixturePath, join(root, 'coverage', 'coverage-summary.json'))
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
      },
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(90))
    expect(r.status).toBe('fail')
    expect(r.actions[0]?.severity).toBe('block')
  })

  it('usa o summary mesmo com exit != 0 e stderr mencionando provider (testes falhando ainda medem coverage)', async () => {
    withVitest()
    const gate = createCoverageGate({
      run: async () => {
        mkdirSync(join(root, 'coverage'), { recursive: true })
        cpSync(fixturePath, join(root, 'coverage', 'coverage-summary.json'))
        return {
          exitCode: 1,
          stdout: '',
          // dump de teste falhando que por acaso contém a string "coverage provider"
          stderr: 'FAIL tests/x.test.ts > expect(r.message).toContain("coverage provider")',
          timedOut: false,
          failed: true,
        }
      },
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(r.status).toBe('pass')
    expect(r.current).toEqual({ percentage: 87.0 })
  })

  it('remove VITEST* do env passado ao runner (reentrância vitest-dentro-de-vitest)', async () => {
    withVitest()
    let seenEnv: Record<string, string | undefined> | undefined
    const gate = createCoverageGate({
      run: async (_bin, _args, opts) => {
        seenEnv = opts.env
        mkdirSync(join(root, 'coverage'), { recursive: true })
        cpSync(fixturePath, join(root, 'coverage', 'coverage-summary.json'))
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false }
      },
    })
    await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(seenEnv).toBeDefined()
    // execa (extendEnv padrão) remove do env do filho as chaves com valor undefined
    for (const key of ['VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID']) {
      expect(key in seenEnv!, `${key} deve estar presente como undefined`).toBe(true)
      expect(seenEnv![key]).toBeUndefined()
    }
  })

  it('error com orientação quando o provider de coverage falta', async () => {
    withVitest()
    const gate = createCoverageGate({
      run: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'Error: Cannot find dependency @vitest/coverage-v8',
        timedOut: false,
        failed: true,
      }),
    })
    const r = await gate.run(ctxWithTools(['vitest']), baselineWith(85))
    expect(r.status).toBe('error')
    expect(r.message).toContain('coverage provider')
  })
})
