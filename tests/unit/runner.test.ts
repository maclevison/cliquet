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
  it('has the 9 gates in the fixed order from spec §5', () => {
    expect(ALL_GATES.map((g) => g.name)).toEqual([
      'security', 'style', 'static_analysis', 'coverage', 'duplication',
      'file_size', 'complexity', 'performance', 'bundle_size',
    ])
  })
})

describe('runCheck', () => {
  it('aggregates to pass when all pass or are skipped', async () => {
    const result = await runCheck(fakeCtx, DEFAULT_BASELINE, [fakeGate('a', 'pass'), fakeGate('b', 'skip')])
    expect(result.result).toBe('pass')
    expect(result.summary).toEqual({ total: 2, passed: 1, failed: 0, skipped: 1, errored: 0 })
  })

  it('fails when one gate fails and collects the actions in order', async () => {
    const warn = { gate: 'a', type: 'W', severity: 'warn', priority: 0, message: 'w', files: [] }
    const block2 = { gate: 'b', type: 'B2', severity: 'block', priority: 2, message: 'b2', files: [] }
    const block1 = { gate: 'b', type: 'B1', severity: 'block', priority: 1, message: 'b1', files: [] }
    const result = await runCheck(fakeCtx, DEFAULT_BASELINE, [
      fakeGate('a', 'pass', [warn]),
      fakeGate('b', 'fail', [block2, block1]),
    ])
    expect(result.result).toBe('fail')
    expect(result.actions.map((a) => a.type)).toEqual(['B1', 'B2', 'W']) // block by priority, warn last
  })

  it('a gate that throws becomes status error and overall result fail (spec §9)', async () => {
    const boom: Gate = { name: 'boom', label: 'Boom', run: async () => { throw new Error('kaput') } }
    const result = await runCheck(fakeCtx, DEFAULT_BASELINE, [fakeGate('a', 'pass'), boom])
    expect(result.result).toBe('fail')
    expect(result.gates.find((g) => g.name === 'boom')?.status).toBe('error')
    expect(result.summary.errored).toBe(1)
  })

  it('preserves presentation order even with parallelism', async () => {
    const slow: Gate = {
      name: 'slow', label: 'Slow',
      run: () => new Promise((resolve) => setTimeout(() => resolve({ status: 'pass', message: '', baseline: {}, current: {}, actions: [] }), 50)),
    }
    const result = await runCheck(fakeCtx, DEFAULT_BASELINE, [slow, fakeGate('fast', 'pass')])
    expect(result.gates.map((g) => g.name)).toEqual(['slow', 'fast'])
  })
})
