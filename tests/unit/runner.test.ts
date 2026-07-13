import { describe, it, expect } from 'vitest'
import { runCheck, ALL_GATES } from '../../src/runner.js'
import { DEFAULT_BASELINE } from '../../src/baseline.js'
import type { Gate, ProjectContext } from '../../src/types.js'

const fakeCtx: ProjectContext = {
  rootPath: '/fake',
  sourceDirs: ['/fake/src'],
  packageManager: null,
  resolveTool: () => null,
  timeoutMs: 300_000,
}

function fakeGate(name: string, status: 'pass' | 'fail' | 'skip', actions: object[] = []): Gate {
  return {
    name,
    label: name,
    run: async () => ({ status, message: `${name} ${status}`, baseline: {}, current: {}, actions: actions as never }),
  }
}

describe('ALL_GATES', () => {
  it('tem as 9 gates na ordem fixa da spec §5', () => {
    expect(ALL_GATES.map((g) => g.name)).toEqual([
      'security', 'style', 'static_analysis', 'coverage', 'duplication',
      'file_size', 'complexity', 'performance', 'bundle_size',
    ])
  })
})

describe('runCheck', () => {
  it('agrega pass quando todas passam ou são skip', async () => {
    const result = await runCheck(fakeCtx, DEFAULT_BASELINE, [fakeGate('a', 'pass'), fakeGate('b', 'skip')])
    expect(result.result).toBe('pass')
    expect(result.summary).toEqual({ total: 2, passed: 1, failed: 0, skipped: 1, errored: 0 })
  })

  it('falha quando uma gate falha e coleta as ações ordenadas', async () => {
    const warn = { gate: 'a', type: 'W', severity: 'warn', priority: 0, message: 'w', files: [] }
    const block2 = { gate: 'b', type: 'B2', severity: 'block', priority: 2, message: 'b2', files: [] }
    const block1 = { gate: 'b', type: 'B1', severity: 'block', priority: 1, message: 'b1', files: [] }
    const result = await runCheck(fakeCtx, DEFAULT_BASELINE, [
      fakeGate('a', 'pass', [warn]),
      fakeGate('b', 'fail', [block2, block1]),
    ])
    expect(result.result).toBe('fail')
    expect(result.actions.map((a) => a.type)).toEqual(['B1', 'B2', 'W']) // block por priority, warn no fim
  })

  it('gate que lança vira status error e resultado geral fail (spec §9)', async () => {
    const boom: Gate = { name: 'boom', label: 'Boom', run: async () => { throw new Error('kaput') } }
    const result = await runCheck(fakeCtx, DEFAULT_BASELINE, [fakeGate('a', 'pass'), boom])
    expect(result.result).toBe('fail')
    expect(result.gates.find((g) => g.name === 'boom')?.status).toBe('error')
    expect(result.summary.errored).toBe(1)
  })

  it('preserva a ordem de apresentação mesmo com paralelismo', async () => {
    const slow: Gate = {
      name: 'slow', label: 'Slow',
      run: () => new Promise((resolve) => setTimeout(() => resolve({ status: 'pass', message: '', baseline: {}, current: {}, actions: [] }), 50)),
    }
    const result = await runCheck(fakeCtx, DEFAULT_BASELINE, [slow, fakeGate('fast', 'pass')])
    expect(result.gates.map((g) => g.name)).toEqual(['slow', 'fast'])
  })
})
